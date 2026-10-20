import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Password-reset OTP flow (e2e, happy path + wrong code). MAIL_PROVIDER=fake
 * in test env so no external call happens; the OTP hash is read back from
 * the DB only to derive the code deterministically per attempt is NOT
 * possible — instead the happy path requests a code, reads the stored hash,
 * and brute-forces nothing: it verifies with a wrong code (400) then fetches
 * the raw code path via a second request is skipped; the full happy path is
 * covered by unit tests. Here we assert the contract: request 404s unknown
 * emails (see ADR 0078), verify rejects garbage, reset rejects bad tokens.
 */
describe('Password reset OTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  const email = `e2e-reset-${suffix}@example.com`;
  const password = 'long-enough-password';
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'E2E Reset' })
      .expect(201);
    createdUserIds.push((res.body as { user: { id: string } }).user.id);
  });

  afterAll(async () => {
    await prisma.passwordReset.deleteMany({
      where: { user: { email } },
    });
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('request -> 404 for unknown emails (not registered)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/request')
      .send({ email: `unknown-${suffix}@example.com` })
      .expect(404);
  });

  it('request -> 200 for a LOCAL user', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/request')
      .send({ email })
      .expect(200)
      .expect({ ok: true });
  });

  it('verify -> 400 for a wrong code', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/verify')
      .send({ email, code: '000000' })
      .expect(400);
  });

  it('reset -> 400 for an unknown reset token', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/reset')
      .send({
        email,
        resetToken: 'bogus-token',
        password: 'another-long-password',
        confirmPassword: 'another-long-password',
      })
      .expect(400);
  });

  it('full flow -> verify with the real OTP then reset logs in with the new password', async () => {
    // Read the pending challenge hash back is impossible to reverse, so we
    // plant our own challenge with a known code hash (test-only setup).
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const code = '123456';
    const challenge = await prisma.passwordReset.create({
      data: {
        userId: user.id,
        codeHash: createHash('sha256').update(code, 'utf8').digest('hex'),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    expect(challenge.id).toBeDefined();

    const verified = await request(app.getHttpServer())
      .post('/api/v1/auth/password/verify')
      .send({ email, code })
      .expect(200);
    const resetToken = (verified.body as { resetToken: string }).resetToken;
    expect(typeof resetToken).toBe('string');

    const nextPassword = 'brand-new-password-1';
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/reset')
      .send({ email, resetToken, password: nextPassword, confirmPassword: nextPassword })
      .expect(200)
      .expect({ ok: true });

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: nextPassword })
      .expect(200);
  });
});
