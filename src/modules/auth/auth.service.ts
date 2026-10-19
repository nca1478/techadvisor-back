import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { Role } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { UsersService, toSafeUser, type SafeUser } from '../users/users.service.js';
import { PasswordService } from './password.service.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.util.js';
import { GoogleIdTokenVerifier } from './google-id-token.verifier.js';
import type { GoogleLoginInput, LoginInput, RefreshInput, RegisterInput } from './auth.schemas.js';

export interface TokenPair {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
}

/**
 * Registration, login, rotation and logout. Public sign-up always creates
 * CUSTOMER (the role is never taken from request input). Login failures
 * always answer `Invalid credentials` so they do not reveal whether the
 * email exists. Refresh tokens rotate on every use; reusing a revoked
 * token revokes all of the user's tokens (theft detection).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly googleVerifier: GoogleIdTokenVerifier,
  ) {}

  async register(input: RegisterInput): Promise<{ user: SafeUser; tokens: TokenPair }> {
    const email = normalizeEmail(input.email);
    const existing = await this.users.findByEmail(email);
    if (existing !== null) {
      throw new ConflictException('Email already registered');
    }
    const user = await this.users.create({ email, password: input.password, name: input.name });
    const tokens = await this.issueTokenPair(user.id, user.role);
    return { user, tokens };
  }

  async login(input: LoginInput): Promise<{ user: SafeUser; tokens: TokenPair }> {
    const email = normalizeEmail(input.email);
    const candidate = await this.users.findByEmailWithHash(email);
    if (
      candidate === null ||
      candidate.passwordHash === null ||
      !(await this.passwords.verify(candidate.passwordHash, input.password))
    ) {
      // Same message for unknown email and wrong password (no user enumeration).
      throw new UnauthorizedException('Invalid credentials');
    }
    const user = toSafeUser(candidate);
    const tokens = await this.issueTokenPair(user.id, user.role);
    return { user, tokens };
  }

  /**
   * Google sign-in: verifies the credential (GIS ID token or OAuth2 access
   * token from the popup flow), then finds-or-creates the user by verified
   * email. New users are CUSTOMER/provider GOOGLE without a password;
   * existing users (LOCAL or GOOGLE) sign in unchanged — their provider is
   * never rewritten here. Never sends personal data to the LLM.
   */
  async loginWithGoogle(input: GoogleLoginInput): Promise<{ user: SafeUser; tokens: TokenPair }> {
    const profile =
      input.accessToken !== undefined
        ? await this.googleVerifier.verifyAccessToken(input.accessToken)
        : await this.googleVerifier.verify(input.idToken as string);
    const email = normalizeEmail(profile.email);
    const existing = await this.users.findByEmail(email);
    if (existing !== null) {
      const tokens = await this.issueTokenPair(existing.id, existing.role);
      return { user: existing, tokens };
    }
    const user = await this.users.createGoogleUser({ email, name: profile.name });
    const tokens = await this.issueTokenPair(user.id, user.role);
    return { user, tokens };
  }

  async refresh(input: RefreshInput): Promise<{ tokens: TokenPair }> {
    const tokenHash = hashRefreshToken(input.refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (stored === null || stored.expiresAt.getTime() <= Date.now()) {
      if (stored !== null) {
        await this.revokeToken(stored.id);
      }
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (stored.revokedAt !== null) {
      await this.revokeAllUserTokens(stored.userId);
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Atomic rotation: claim the presented token (set revokedAt) only if it
    // is still unrevoked, and create its replacement in the same
    // transaction. A concurrent second use finds zero claimable rows and is
    // treated as reuse (theft detection).
    try {
      const tokens = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.refreshToken.updateMany({
          where: { id: stored.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (claimed.count === 0) {
          throw new RefreshReuseError();
        }
        const next = generateRefreshToken();
        await tx.refreshToken.create({
          data: {
            userId: stored.userId,
            tokenHash: hashRefreshToken(next),
            expiresAt: new Date(Date.now() + this.config.JWT_REFRESH_EXPIRES_IN_SEC * 1000),
          },
        });
        const accessToken = await this.jwt.signAsync({
          sub: stored.userId,
          role: stored.user.role,
        });
        return {
          accessToken,
          tokenType: 'Bearer' as const,
          expiresIn: this.config.JWT_ACCESS_EXPIRES_IN_SEC,
          refreshToken: next,
        };
      });
      return { tokens };
    } catch (error) {
      if (error instanceof RefreshReuseError) {
        await this.revokeAllUserTokens(stored.userId);
        throw new UnauthorizedException('Invalid refresh token');
      }
      // Unexpected failures (DB, signer) propagate as 500 — they must not
      // masquerade as invalid tokens.
      throw error;
    }
  }

  /**
   * Revokes the presented refresh token. Idempotent: unknown or already
   * revoked tokens still answer success so logout cannot be used as an
   * oracle for token validity.
   */
  async logout(input: RefreshInput): Promise<{ ok: true }> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(input.refreshToken) },
      select: { id: true, revokedAt: true },
    });
    if (stored !== null && stored.revokedAt === null) {
      await this.revokeToken(stored.id);
    }
    return { ok: true as const };
  }

  private async issueTokenPair(userId: string, role: Role): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ sub: userId, role });
    const refreshToken = generateRefreshToken();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + this.config.JWT_REFRESH_EXPIRES_IN_SEC * 1000),
      },
    });
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.config.JWT_ACCESS_EXPIRES_IN_SEC,
      refreshToken,
    };
  }

  private async revokeToken(id: string): Promise<void> {
    await this.prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  private async revokeAllUserTokens(userId: string): Promise<void> {
    // Revoked token reused: possible theft — revoke every active token
    // of the user and force a fresh login.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

/** Internal marker: the presented refresh token was already rotated. */
class RefreshReuseError extends Error {
  constructor() {
    super('Refresh token already rotated');
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
