import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { parseEnv } from '../src/config/env.schema.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Reindex admin surface (e2e, see ADR 0023).
 *
 * Assumes the local env (backend/.env): the configured EMBEDDING_MODEL/DIM
 * is the ACTIVE model, so `POST /admin/reindex` deterministically answers
 * 409 ("already active") without touching any provider or queue — this
 * suite covers auth, validation and the already-active path only. The full
 * 8d → 16d switch runs in `reindex.service.integration.spec.ts` against
 * the same database.
 */
describe('Reindex admin (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  const createdUserIds: string[] = [];
  let adminToken = '';
  let customerToken = '';

  const routes: { method: 'get' | 'post'; path: string }[] = [
    { method: 'post', path: '/api/v1/admin/reindex' },
    { method: 'get', path: '/api/v1/admin/reindex/active' },
    { method: 'get', path: '/api/v1/admin/reindex/jobs/00000000-0000-0000-0000-000000000000' },
    {
      method: 'post',
      path: '/api/v1/admin/reindex/jobs/00000000-0000-0000-0000-000000000000/activate',
    },
    {
      method: 'post',
      path: '/api/v1/admin/reindex/jobs/00000000-0000-0000-0000-000000000000/resume',
    },
  ];

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    // Start from a clean slate so `active` always seeds deterministically
    // from env (a crashed run could have left a divergent pointer behind;
    // no other e2e suite reads this table — search pins its own scope).
    await prisma.ragEmbeddingState.deleteMany({ where: { key: 'active' } });
    const passwords = ctx.module.get(PasswordService);

    const adminEmail = `e2e-rx-admin-${suffix}@example.com`;
    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await passwords.hash('long-enough-password'),
        role: 'ADMIN',
      },
      select: { id: true },
    });
    createdUserIds.push(admin.id);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: 'long-enough-password' })
      .expect(200);
    adminToken = (login.body as { tokens: { accessToken: string } }).tokens.accessToken;

    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: `e2e-rx-customer-${suffix}@example.com`, password: 'long-enough-password' })
      .expect(201);
    customerToken = (registered.body as { tokens: { accessToken: string } }).tokens.accessToken;
    createdUserIds.push((registered.body as { user: { id: string } }).user.id);
  });

  afterAll(async () => {
    await prisma.ragEmbeddingState.deleteMany({ where: { key: 'active' } });
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('requires authentication (401 without token)', async () => {
    const server = app.getHttpServer();
    for (const route of routes) {
      const res = await request(server)[route.method](route.path).expect(401);
      expect((res.body as { statusCode: number }).statusCode).toBe(401);
    }
  });

  it('rejects CUSTOMER tokens (403)', async () => {
    const server = app.getHttpServer();
    for (const route of routes) {
      const res = await request(server)
        [route.method](route.path)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
      expect((res.body as { statusCode: number }).statusCode).toBe(403);
    }
  });

  it('reports the active model seeded from env', async () => {
    const env = parseEnv();
    const expectedModel =
      env.EMBEDDING_MODEL === undefined || env.EMBEDDING_MODEL.length === 0
        ? 'fake-hash-v1'
        : env.EMBEDDING_MODEL;

    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/reindex/active')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body as Record<string, unknown>).toMatchObject({
      model: expectedModel,
      dim: env.EMBEDDING_DIM,
    });
  });

  it('refuses to start when the target model is already active (409)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/reindex')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);

    expect((res.body as { message: string }).message).toContain('already active');
  });

  it('validates job ids (400) and reports unknown jobs (404)', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };

    await request(server).get('/api/v1/admin/reindex/jobs/not-a-uuid').set(auth).expect(400);
    await request(server)
      .get('/api/v1/admin/reindex/jobs/00000000-0000-0000-0000-000000000000')
      .set(auth)
      .expect(404);
    await request(server)
      .post('/api/v1/admin/reindex/jobs/00000000-0000-0000-0000-000000000000/activate')
      .set(auth)
      .expect(404);
    await request(server)
      .post('/api/v1/admin/reindex/jobs/00000000-0000-0000-0000-000000000000/resume')
      .set(auth)
      .expect(404);
  });
});
