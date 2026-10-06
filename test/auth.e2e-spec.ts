import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { createTestApp } from './test-app.js';

interface TokenPairBody {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string;
}

describe('Auth + Users + Admin roles (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwords: PasswordService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  const email = `e2e-customer-${suffix}@example.com`;
  const password = 'long-enough-password';
  const createdUserIds: string[] = [];

  let accessToken = '';
  let refreshToken = '';

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    passwords = ctx.module.get(PasswordService);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('register -> creates a CUSTOMER and returns a token pair (no passwordHash)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'E2E Customer' })
      .expect(201);

    const body = res.body as { user: Record<string, unknown>; tokens: TokenPairBody };
    expect(body.user).toMatchObject({ email, role: 'CUSTOMER' });
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.tokens.tokenType).toBe('Bearer');
    expect(typeof body.tokens.accessToken).toBe('string');
    expect(typeof body.tokens.refreshToken).toBe('string');
    createdUserIds.push(body.user['id'] as string);
    accessToken = body.tokens.accessToken;
    refreshToken = body.tokens.refreshToken;
  });

  it('register -> 409 on duplicate email', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'another-long-password' })
      .expect(409)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      });
  });

  it('register -> 400 on invalid email and short password', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short' })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 400 });
      });
  });

  it('login -> 401 with a generic message for unknown email and wrong password', async () => {
    for (const payload of [
      { email: `unknown-${suffix}@example.com`, password },
      { email, password: 'wrong-password-xyz' },
    ]) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send(payload)
        .expect(401)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            statusCode: 401,
            code: 'UNAUTHORIZED',
            message: 'Invalid credentials',
          });
        });
    }
  });

  it('login -> returns tokens for valid credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    const body = res.body as { user: Record<string, unknown>; tokens: TokenPairBody };
    expect(body.user).toMatchObject({ email, role: 'CUSTOMER' });
    expect(body.user).not.toHaveProperty('passwordHash');
    accessToken = body.tokens.accessToken;
    refreshToken = body.tokens.refreshToken;
  });

  it('GET /users/me -> 401 without token, 200 with token', async () => {
    await request(app.getHttpServer()).get('/api/v1/users/me').expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ email, role: 'CUSTOMER' });
        expect(body).not.toHaveProperty('passwordHash');
      });
  });

  it('GET /admin/ping -> 403 for CUSTOMER', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/ping')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      });
  });

  it('GET /admin/ping -> 200 for ADMIN', async () => {
    const adminEmail = `e2e-admin-${suffix}@example.com`;
    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await passwords.hash(password),
        role: 'ADMIN',
      },
      select: { id: true },
    });
    createdUserIds.push(admin.id);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password })
      .expect(200);
    const adminTokens = (login.body as { tokens: TokenPairBody }).tokens;

    await request(app.getHttpServer())
      .get('/api/v1/admin/ping')
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({ ok: true });
      });
  });

  it('refresh -> rotates: new pair works, old refresh token is rejected', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    const next = (res.body as { tokens: TokenPairBody }).tokens;
    expect(next.refreshToken).not.toBe(refreshToken);

    // The rotated (now revoked) token must be rejected.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    refreshToken = next.refreshToken;
    accessToken = next.accessToken;
  });

  it('logout -> revokes the refresh token; further refresh fails', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({ ok: true });
      });

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    // Access token from before logout still authenticates /users/me until it expires.
    await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });
});
