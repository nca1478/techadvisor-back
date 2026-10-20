import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PasswordService } from '../auth/password.service.js';
import type { AuthProvider, Role } from '../../generated/prisma/client.js';

/** Public user shape — never includes `passwordHash`. */
export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  provider: AuthProvider;
  createdAt: Date;
  updatedAt: Date;
}

export function toSafeUser(user: {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  provider: AuthProvider;
  createdAt: Date;
  updatedAt: Date;
}): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    provider: user.provider,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * User persistence. Password hashing lives here so every creation path
 * hashes; `findByEmailWithHash` exists only for the login check inside
 * `AuthService` and must never be exposed through a controller.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async create(input: { email: string; password: string; name?: string }): Promise<SafeUser> {
    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.prisma.user.create({
      data: {
        // Public sign-up always creates CUSTOMER; ADMIN is granted
        // out-of-band (seed/scripts), never from request input.
        email: input.email,
        passwordHash,
        name: input.name,
        role: 'CUSTOMER',
        provider: 'LOCAL',
      },
    });
    return toSafeUser(user);
  }

  /**
   * Creates a CUSTOMER without a local password for Google sign-in
   * (provider GOOGLE, passwordHash NULL). Role is always CUSTOMER.
   */
  async createGoogleUser(input: { email: string; name?: string | null }): Promise<SafeUser> {
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash: null,
        name: input.name ?? null,
        role: 'CUSTOMER',
        provider: 'GOOGLE',
      },
    });
    return toSafeUser(user);
  }

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? toSafeUser(user) : null;
  }

  async findByEmail(email: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    return user ? toSafeUser(user) : null;
  }

  /**
   * Updates the caller's own profile. Only `name` and `password` are
   * accepted — `email` can never change here. Passwords are re-hashed;
   * a stale token (row gone) surfaces as unauthorized, like `me()`.
   */
  async updateProfile(id: string, input: { name?: string; password?: string }): Promise<SafeUser> {
    const data: { name?: string; passwordHash?: string } = {};
    if (input.name !== undefined) {
      data.name = input.name;
    }
    if (input.password !== undefined) {
      data.passwordHash = await this.passwords.hash(input.password);
    }
    try {
      const user = await this.prisma.user.update({ where: { id }, data });
      return toSafeUser(user);
    } catch {
      // Prisma P2025 (row gone between auth and update): the token is stale.
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /** Sets a new local password (password-reset flow). Re-hashes always. */
  async setPassword(
    id: string,
    plain: string,
    passwords?: { hash(password: string): Promise<string> },
  ): Promise<void> {
    const hasher = passwords ?? this.passwords;
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await hasher.hash(plain) },
    });
  }

  /** Internal: full row including `passwordHash`, for the login check only. */
  async findByEmailWithHash(email: string): Promise<{
    id: string;
    email: string;
    name: string | null;
    role: Role;
    provider: AuthProvider;
    createdAt: Date;
    updatedAt: Date;
    passwordHash: string | null;
  } | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        provider: true,
        createdAt: true,
        updatedAt: true,
        passwordHash: true,
      },
    });
  }
}
