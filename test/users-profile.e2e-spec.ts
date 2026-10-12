import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

describe('PATCH /users/me (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  const email = `e2e-profile-${suffix}@example.com`;
  const password = 'long-enough-password';
  const createdUserIds: string[] = [];
  let accessToken = '';

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);

    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'E2E Before' })
      .expect(201);
    const body = res.body as { user: { id: string }; tokens: { accessToken: string } };
    createdUserIds.push(body.user.id);
    accessToken = body.tokens.accessToken;
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('401 without token', async () => {
    await request(app.getHttpServer()).patch('/api/v1/users/me').send({ name: 'Nope' }).expect(401);
  });

  it('400 on empty body and on short password', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(400);

    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: 'short' })
      .expect(400);
  });

  it('updates the name and never changes the email', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'E2E After', email: 'hacker@example.com' })
      .expect(200);

    const body = res.body as Record<string, unknown>;
    expect(body).toMatchObject({ email, name: 'E2E After' });
    expect(body).not.toHaveProperty('passwordHash');
    expect(body['email']).toBe(email);
  });

  it('updates the password: login works with the new one, fails with the old one', async () => {
    const next = 'brand-new-long-password';
    await request(app.getHttpServer())
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: next })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).not.toHaveProperty('passwordHash');
      });

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: next })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(401);
  });
});
