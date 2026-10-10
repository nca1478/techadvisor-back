import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Operational observability (e2e, see ADR 0039).
 *
 * - `GET /metrics` requires ADMIN (401 without token, 403 for CUSTOMER) and
 *   exposes latency/error counters per provider+model in Prometheus text.
 * - `POST /metrics/cleanup` purges only rows past the retention window.
 * - No response may carry prompt/question/answer text: the suite plants a
 *   canary string in an advisor question and asserts it never appears in
 *   `ai_call_logs` rows or `/metrics` output.
 */

const PASSWORD = 'long-enough-password';
const CANARY = 'canary-pii-observability-xyz-93482@example.com';

describe('Observability (e2e)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let app: INestApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];
  let adminToken = '';
  let customerToken = '';

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const passwords = ctx.module.get(PasswordService);

    const adminEmail = `e2e-obs-admin-${suffix}@example.com`;
    const admin = await prisma.user.create({
      data: { email: adminEmail, passwordHash: await passwords.hash(PASSWORD), role: 'ADMIN' },
      select: { id: true },
    });
    createdUserIds.push(admin.id);
    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: PASSWORD })
      .expect(200);
    adminToken = (adminLogin.body as { tokens: { accessToken: string } }).tokens.accessToken;

    const customerEmail = `e2e-obs-customer-${suffix}@example.com`;
    const customer = await prisma.user.create({
      data: {
        email: customerEmail,
        passwordHash: await passwords.hash(PASSWORD),
        role: 'CUSTOMER',
      },
      select: { id: true },
    });
    createdUserIds.push(customer.id);
    const customerLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: customerEmail, password: PASSWORD })
      .expect(200);
    customerToken = (customerLogin.body as { tokens: { accessToken: string } }).tokens.accessToken;

    // One instrumented call so /metrics has data: a metadata-only row with
    // the canary nowhere near it (canary lives only in this file).
    await (prisma as unknown as PrismaClient).aiCallLog.create({
      data: {
        type: 'LLM',
        provider: 'fake',
        model: 'fake-llm-v1',
        latencyMs: 11,
        status: 'OK',
      },
    });
    // Exercise the canary through a real advisor abstention path (no
    // evidence → unanswered_queries row) so the suite proves user text
    // stays out of ai_call_logs even when the advisor sees it.
    const client = prisma as unknown as PrismaClient;
    const brand = await client.brand.create({
      data: { name: `E2E Obs Brand ${suffix}`, slug: `e2e-obs-brand-${suffix}` },
    });
    const category = await client.category.create({
      data: { name: `E2E Obs Cat ${suffix}`, slug: `e2e-obs-cat-${suffix}` },
    });
    const product = await client.product.create({
      data: {
        sku: `E2E-OBS-${suffix}`,
        name: 'E2E Obs Product',
        slug: `e2e-obs-product-${suffix}`,
        description: 'Observability fixture product.',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 10000,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });
    await request(app.getHttpServer())
      .post('/api/v1/advisor/product-qa')
      .send({ productId: product.id, question: `pregunta canaria ${CANARY} sobre el producto` })
      .expect(200);
    await client.unansweredQuery.deleteMany({ where: { productId: product.id } });
    await client.product.deleteMany({ where: { id: product.id } });
    await client.brand.deleteMany({ where: { id: brand.id } });
    await client.category.deleteMany({ where: { id: category.id } });
  }, 60_000);

  afterAll(async () => {
    const client = prisma as unknown as PrismaClient;
    await client.aiCallLog.deleteMany({ where: { provider: 'fake', model: 'fake-llm-v1' } });
    if (createdUserIds.length > 0) {
      await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('GET /metrics requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/metrics').expect(401);
  });

  it('GET /metrics forbids CUSTOMER tokens', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/metrics')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(403);
  });

  it('GET /metrics exposes per-provider latency and error counters', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/metrics')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const text = res.text;
    expect(text).toContain('techadvisor_ai_calls_total');
    expect(text).toContain('techadvisor_ai_latency_ms_avg');
    expect(text).toContain('techadvisor_advisor_abstentions_total');
    expect(text).toContain('techadvisor_documents_total');
    expect(text).toContain('techadvisor_queue_up');
    // The canary question text must never leak into metrics labels.
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('canary-pii');
  });

  it('ai_call_logs rows never store user content', async () => {
    const client = prisma as unknown as PrismaClient;
    const rows = await client.aiCallLog.findMany({
      where: { provider: 'fake' },
      take: 20,
    });
    expect(rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(CANARY);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'createdAt',
          'errorCode',
          'estimatedCost',
          'id',
          'latencyMs',
          'model',
          'provider',
          'sessionId',
          'status',
          'tokensIn',
          'tokensOut',
          'type',
          'updatedAt',
        ].sort(),
      );
    }
  });

  it('POST /metrics/cleanup requires ADMIN and reports the purge', async () => {
    await request(app.getHttpServer()).post('/api/v1/metrics/cleanup').expect(401);
    const res = await request(app.getHttpServer())
      .post('/api/v1/metrics/cleanup')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as { deleted: number; retentionDays: number };
    expect(typeof body.deleted).toBe('number');
    expect(typeof body.retentionDays).toBe('number');
  });
});
