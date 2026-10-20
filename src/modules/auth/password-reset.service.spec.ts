import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { UsersService } from '../users/users.service.js';
import { PasswordResetService } from './password-reset.service.js';

const CONFIG = {
  PASSWORD_RESET_OTP_TTL_MIN: 10,
  PASSWORD_RESET_OTP_LENGTH: 6,
  PASSWORD_RESET_MAX_ATTEMPTS: 5,
  PASSWORD_RESET_REQUEST_COOLDOWN_SEC: 60,
  PASSWORD_RESET_TOKEN_TTL_MIN: 15,
  MAIL_REPLY_TO: 'soporte@example.com',
} as AppConfig;

const LOCAL_ROW = {
  id: 'user-1',
  email: 'ada@example.com',
  name: 'Ada',
  role: 'CUSTOMER' as const,
  provider: 'LOCAL' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
  passwordHash: 'hash',
};

function harness() {
  const users = {
    findByEmailWithHash: vi.fn(),
    setPassword: vi.fn(() => Promise.resolve()),
  };
  const passwords = { hash: vi.fn(), verify: vi.fn() };
  const passwordReset = {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
  };
  const prisma = { passwordReset } as unknown as PrismaService;
  const mail = { send: vi.fn(() => Promise.resolve()) };
  const service = new PasswordResetService(
    users as unknown as UsersService,
    passwords,
    prisma,
    CONFIG,
    mail,
  );
  return { service, users, prisma: passwordReset, mail };
}

const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

describe('PasswordResetService', () => {
  it('request rejects unknown emails with 404 (not registered)', async () => {
    const { service, users, mail, prisma } = harness();
    users.findByEmailWithHash.mockResolvedValue(null);

    await expect(service.request({ email: 'Nobody@Example.com' })).rejects.toMatchObject({
      status: 404,
    });
    expect(mail.send.mock.calls).toHaveLength(0);
    expect(prisma.create.mock.calls).toHaveLength(0);
  });

  it('request rejects Google users with 409 (password cannot be changed)', async () => {
    const { service, users, mail } = harness();
    users.findByEmailWithHash.mockResolvedValue({
      ...LOCAL_ROW,
      provider: 'GOOGLE',
      passwordHash: null,
    });

    await expect(service.request({ email: 'ada@example.com' })).rejects.toMatchObject({
      status: 409,
    });
    expect(mail.send.mock.calls).toHaveLength(0);
  });

  it('verify + confirm rotate the password and consume the challenge', async () => {
    const { service, users, prisma } = harness();
    users.findByEmailWithHash.mockResolvedValue({ ...LOCAL_ROW });
    prisma.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      userId: 'user-1',
      codeHash: sha('123456'),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
      verifiedAt: null,
    });
    prisma.update.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'pr-1', ...args.data }),
    );

    const verified = await service.verify({ email: 'ada@example.com', code: '123456' });
    expect(typeof verified.resetToken).toBe('string');
    expect(verified.expiresIn).toBe(900);

    prisma.findFirst.mockResolvedValueOnce({
      id: 'pr-1',
      verifiedAt: new Date(),
      resetTokenExpiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    });
    await expect(
      service.confirm({
        email: 'ada@example.com',
        resetToken: verified.resetToken,
        password: 'long-enough-password',
        confirmPassword: 'long-enough-password',
      }),
    ).resolves.toEqual({ ok: true });
    expect(users.setPassword.mock.calls[0]?.slice(0, 2)).toEqual([
      'user-1',
      'long-enough-password',
    ]);
  });

  it('verify rejects a wrong code and counts the attempt', async () => {
    const { service, users, prisma } = harness();
    users.findByEmailWithHash.mockResolvedValue({ ...LOCAL_ROW });
    prisma.findFirst.mockResolvedValue({
      id: 'pr-1',
      codeHash: sha('123456'),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });

    await expect(
      service.verify({ email: 'ada@example.com', code: '000000' }),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.update.mock.calls).toEqual([
      [
        {
          where: { id: 'pr-1' },
          data: { attempts: { increment: 1 } },
        },
      ],
    ]);
  });

  it('cleanupExpired deletes only dead challenges and reports the count', async () => {
    const { service, prisma } = harness();
    prisma.deleteMany.mockResolvedValue({ count: 3 });

    const now = new Date('2026-10-21T00:00:00.000Z');
    await expect(service.cleanupExpired(now)).resolves.toEqual({ deleted: 3 });
    expect(prisma.deleteMany.mock.calls).toEqual([
      [
        {
          where: {
            OR: [
              { consumedAt: { not: null } },
              { expiresAt: { lt: now }, resetTokenHash: null },
              { expiresAt: { lt: now }, resetTokenExpiresAt: { lt: now } },
            ],
          },
        },
      ],
    ]);
  });

  it('request purges the user dead challenges before issuing a new code', async () => {
    const { service, users, prisma, mail } = harness();
    users.findByEmailWithHash.mockResolvedValue({ ...LOCAL_ROW });
    prisma.findFirst.mockResolvedValue(null);
    prisma.create.mockResolvedValue({ id: 'pr-1' });

    await expect(service.request({ email: 'ada@example.com' })).resolves.toEqual({ ok: true });
    expect(prisma.deleteMany.mock.calls).toEqual([
      [
        {
          where: {
            userId: 'user-1',
            OR: expect.any(Array),
          },
        },
      ],
    ]);
    expect(mail.send.mock.calls).toHaveLength(1);
  });
});
