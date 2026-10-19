import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { hashRefreshToken } from './refresh-token.util.js';

const CONFIG = {
  JWT_ACCESS_EXPIRES_IN_SEC: 900,
  JWT_REFRESH_EXPIRES_IN_SEC: 2592000,
} as AppConfig;

function createHarness() {
  const users = {
    findByEmail: vi.fn(),
    findByEmailWithHash: vi.fn(),
    create: vi.fn(),
    createGoogleUser: vi.fn(),
  };

  const passwords = {
    hash: vi.fn((plain: string) => Promise.resolve(`hashed:${plain}`)),
    verify: vi.fn(() => Promise.resolve(true)),
  };

  const jwt = {
    signAsync: vi.fn(() => Promise.resolve('signed-access-jwt')),
  };

  const txRefreshToken = {
    updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
    create: vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'new-rt', ...args.data }),
    ),
  };
  const refreshToken = {
    findUnique: vi.fn(),
    create: vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'rt-1', ...args.data }),
    ),
    update: vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'rt-1', ...args.data }),
    ),
    updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
  };
  const prisma = {
    refreshToken,
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) =>
      cb({ refreshToken: txRefreshToken }),
    ),
  };

  const googleVerifier = {
    verify: vi.fn(() => Promise.resolve({ email: 'gin@example.com', name: 'Gin' })),
    verifyAccessToken: vi.fn(() => Promise.resolve({ email: 'gin@example.com', name: 'Gin' })),
  };

  const service = new AuthService(
    users as unknown as UsersService,
    passwords,
    jwt as unknown as JwtService,
    prisma as unknown as PrismaService,
    CONFIG,
    googleVerifier as unknown as import('./google-id-token.verifier.js').GoogleIdTokenVerifier,
  );
  return { service, users, passwords, jwt, prisma, txRefreshToken, googleVerifier };
}

const CUSTOMER_ROW = {
  id: 'user-1',
  email: 'ada@example.com',
  name: 'Ada',
  role: 'CUSTOMER' as const,
  provider: 'LOCAL' as const,
  createdAt: new Date('2026-10-06T12:00:00.000Z'),
  updatedAt: new Date('2026-10-06T12:00:00.000Z'),
};

describe('AuthService', () => {
  describe('register', () => {
    it('creates a CUSTOMER user and returns a token pair', async () => {
      const { service, users, prisma } = createHarness();
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue({ ...CUSTOMER_ROW });

      const result = await service.register({
        email: 'Ada@Example.com',
        password: 'long-enough-password',
      });

      expect(users.create.mock.calls).toEqual([
        [
          {
            email: 'ada@example.com',
            password: 'long-enough-password',
            name: undefined,
          },
        ],
      ]);
      expect(result.user.role).toBe('CUSTOMER');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.tokens.accessToken).toBe('signed-access-jwt');
      expect(typeof result.tokens.refreshToken).toBe('string');
      expect(result.tokens.expiresIn).toBe(900);
      expect(prisma.refreshToken.create.mock.calls).toHaveLength(1);
    });

    it('rejects an already registered email with 409', async () => {
      const { service, users } = createHarness();
      users.findByEmail.mockResolvedValue({ ...CUSTOMER_ROW });

      await expect(
        service.register({ email: 'ada@example.com', password: 'long-enough-password' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('login', () => {
    it('returns user + tokens for valid credentials', async () => {
      const { service, users, passwords } = createHarness();
      users.findByEmailWithHash.mockResolvedValue({ ...CUSTOMER_ROW, passwordHash: 'hash' });
      passwords.verify.mockResolvedValue(true);

      const result = await service.login({ email: 'ada@example.com', password: 'right-password' });

      expect(result.user.email).toBe('ada@example.com');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(result.tokens.tokenType).toBe('Bearer');
      expect(result.tokens.expiresIn).toBe(900);
    });

    it('returns 401 without revealing whether the email exists (unknown email)', async () => {
      const { service, users } = createHarness();
      users.findByEmailWithHash.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@example.com', password: 'whatever' }),
      ).rejects.toMatchObject({
        status: 401,
        message: 'Invalid credentials',
      });
    });

    it('returns the same 401 for a wrong password', async () => {
      const { service, users, passwords } = createHarness();
      users.findByEmailWithHash.mockResolvedValue({ ...CUSTOMER_ROW, passwordHash: 'hash' });
      passwords.verify.mockResolvedValue(false);

      const failure = await service
        .login({ email: 'ada@example.com', password: 'wrong-password' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(UnauthorizedException);
      expect((failure as UnauthorizedException).message).toBe('Invalid credentials');
    });

    it('returns 401 for a Google user without a local password (no password oracle)', async () => {
      const { service, users, passwords } = createHarness();
      users.findByEmailWithHash.mockResolvedValue({ ...CUSTOMER_ROW, passwordHash: null });

      await expect(
        service.login({ email: 'ada@example.com', password: 'whatever-password' }),
      ).rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
      expect(passwords.verify).not.toHaveBeenCalled();
    });
  });

  describe('loginWithGoogle', () => {
    it('signs in the existing user unchanged (no provider rewrite)', async () => {
      const { service, users, googleVerifier, prisma } = createHarness();
      googleVerifier.verify.mockResolvedValue({ email: 'Ada@Example.com', name: 'Ada' });
      users.findByEmail.mockResolvedValue({ ...CUSTOMER_ROW });

      const result = await service.loginWithGoogle({ idToken: 'valid-token' });

      expect(googleVerifier.verify.mock.calls).toEqual([['valid-token']]);
      expect(users.findByEmail.mock.calls).toEqual([['ada@example.com']]);
      expect(users.createGoogleUser).not.toHaveBeenCalled();
      expect(result.user.email).toBe('ada@example.com');
      expect(result.tokens.accessToken).toBe('signed-access-jwt');
      expect(prisma.refreshToken.create.mock.calls).toHaveLength(1);
    });

    it('creates a CUSTOMER without password on first Google use', async () => {
      const { service, users, googleVerifier } = createHarness();
      googleVerifier.verify.mockResolvedValue({ email: 'new@example.com', name: 'New User' });
      users.findByEmail.mockResolvedValue(null);
      users.createGoogleUser.mockResolvedValue({
        ...CUSTOMER_ROW,
        id: 'user-2',
        email: 'new@example.com',
        name: 'New User',
        provider: 'GOOGLE',
      });

      const result = await service.loginWithGoogle({ idToken: 'valid-token' });

      expect(users.createGoogleUser.mock.calls).toEqual([
        [{ email: 'new@example.com', name: 'New User' }],
      ]);
      expect(result.user.provider).toBe('GOOGLE');
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('maps verifier failures to 401', async () => {
      const { service, users, googleVerifier } = createHarness();
      googleVerifier.verify.mockRejectedValue(
        new UnauthorizedException('Invalid Google credential'),
      );

      await expect(service.loginWithGoogle({ idToken: 'bad-token' })).rejects.toMatchObject({
        status: 401,
      });
      expect(users.findByEmail).not.toHaveBeenCalled();
    });

    it('verifies OAuth2 access tokens from the popup flow', async () => {
      const { service, users, googleVerifier } = createHarness();
      googleVerifier.verifyAccessToken.mockResolvedValue({ email: 'Pop@Example.com', name: 'Pop' });
      users.findByEmail.mockResolvedValue(null);
      users.createGoogleUser.mockResolvedValue({
        ...CUSTOMER_ROW,
        id: 'user-3',
        email: 'pop@example.com',
        name: 'Pop',
        provider: 'GOOGLE',
      });

      const result = await service.loginWithGoogle({ accessToken: 'ya29.valid' });

      expect(googleVerifier.verifyAccessToken.mock.calls).toEqual([['ya29.valid']]);
      expect(googleVerifier.verify).not.toHaveBeenCalled();
      expect(users.createGoogleUser.mock.calls).toEqual([
        [{ email: 'pop@example.com', name: 'Pop' }],
      ]);
      expect(result.user.provider).toBe('GOOGLE');
    });
  });

  describe('refresh', () => {
    const stored = {
      id: 'rt-1',
      userId: 'user-1',
      tokenHash: hashRefreshToken('presented-refresh'),
      expiresAt: new Date(Date.now() + 3600_000),
      revokedAt: null,
      user: { ...CUSTOMER_ROW },
    };

    it('rotates the token: claims the old one and issues a new pair', async () => {
      const { service, prisma, txRefreshToken } = createHarness();
      prisma.refreshToken.findUnique.mockResolvedValue(stored);

      const result = await service.refresh({ refreshToken: 'presented-refresh' });

      expect(txRefreshToken.updateMany.mock.calls).toEqual([
        [
          {
            where: { id: 'rt-1', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
          },
        ],
      ]);
      expect(txRefreshToken.create.mock.calls).toHaveLength(1);
      expect(result.tokens.refreshToken).not.toBe('presented-refresh');
    });

    it('rejects an unknown token with 401', async () => {
      const { service, prisma } = createHarness();
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refresh({ refreshToken: 'unknown' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('revokes all user tokens when a rotated token is reused', async () => {
      const { service, prisma } = createHarness();
      prisma.refreshToken.findUnique.mockResolvedValue({ ...stored, revokedAt: new Date() });

      await expect(service.refresh({ refreshToken: 'presented-refresh' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany.mock.calls).toEqual([
        [
          {
            where: { userId: 'user-1', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
          },
        ],
      ]);
    });
  });

  describe('logout', () => {
    it('revokes the presented token and answers ok', async () => {
      const { service, prisma } = createHarness();
      prisma.refreshToken.findUnique.mockResolvedValue({ id: 'rt-1', revokedAt: null });

      await expect(service.logout({ refreshToken: 'token' })).resolves.toEqual({ ok: true });
      expect(prisma.refreshToken.update.mock.calls).toHaveLength(1);
    });

    it('is idempotent for unknown tokens', async () => {
      const { service, prisma } = createHarness();
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.logout({ refreshToken: 'unknown' })).resolves.toEqual({ ok: true });
      expect(prisma.refreshToken.update.mock.calls).toHaveLength(0);
    });
  });
});
