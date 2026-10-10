import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { parseEnv } from '../src/config/env.schema.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { FakeEmbeddingAdapter } from '../src/modules/ai/adapters/fake-embedding.adapter.js';
import { FakeLlmAdapter } from '../src/modules/ai/adapters/fake-llm.adapter.js';
import { EMBEDDING_PROVIDER } from '../src/modules/ai/interfaces/embedding-provider.interface.js';
import { LLM_PROVIDER } from '../src/modules/ai/interfaces/llm-provider.interface.js';
import { INGESTION_QUEUE } from '../src/modules/ingestion/ingestion.constants.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Customer reviews + pros/cons summaries (e2e, see ADR 0037).
 *
 * Boots the full app with the offline fake LLM scripted to return a fixed
 * summary JSON (no provider calls) and a null ingestion queue (no Redis):
 * two products, three buyers (two with PAID orders for product A, one with
 * a PAID order for product B, one stranger with no orders), plus an admin.
 * `REVIEW_SUMMARY_MIN_REVIEWS=2` so one published review shows no summary
 * while two do (the acceptance threshold).
 */

interface Fixture {
  app: INestApplication;
  prisma: PrismaService;
  suffix: string;
  brandId: string;
  categoryId: string;
  productAId: string;
  productBId: string;
  buyerA1: { userId: string; token: string };
  buyerA2: { userId: string; token: string };
  buyerB: { userId: string; token: string };
  stranger: { userId: string; token: string };
  adminToken: string;
  adminId: string;
}

async function registerUser(
  app: INestApplication,
  email: string,
): Promise<{ userId: string; token: string }> {
  const registered = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: 'long-enough-password' })
    .expect(201);
  const body = registered.body as { user: { id: string }; tokens: { accessToken: string } };
  return { userId: body.user.id, token: body.tokens.accessToken };
}

async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: 'long-enough-password' })
    .expect(200);
  return (res.body as { tokens: { accessToken: string } }).tokens.accessToken;
}

async function createFixtures(): Promise<Fixture> {
  const suffix = `r-${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  const fakeEmbeddings = new FakeEmbeddingAdapter({ dimensions: 1536 });
  const llm = new FakeLlmAdapter({
    defaultText: JSON.stringify({
      pros: ['Good battery life'],
      cons: ['A bit heavy'],
      basedOnCount: 2,
    }),
  });
  const ctx = await createTestApp([
    { token: EMBEDDING_PROVIDER, useValue: fakeEmbeddings },
    { token: LLM_PROVIDER, useValue: llm },
    { token: INGESTION_QUEUE, useValue: null },
    {
      token: APP_CONFIG,
      useValue: { ...parseEnv(), REVIEW_SUMMARY_MIN_REVIEWS: 2 },
    },
  ]);
  const { app } = ctx;
  const prisma = ctx.module.get(PrismaService);
  const client = prisma as unknown as PrismaClient;

  const brand = await client.brand.create({
    data: { name: `E2E Review Brand ${suffix}`, slug: `e2e-review-brand-${suffix}` },
  });
  const category = await client.category.create({
    data: { name: `Laptops ${suffix}`, slug: `e2e-review-laptops-${suffix}` },
  });
  const makeProduct = (tag: string) =>
    client.product.create({
      data: {
        sku: `E2E-REVIEW-${tag}-${suffix}`,
        name: `Review Fixture ${tag} ${suffix}`,
        slug: `e2e-review-${tag}-${suffix}`,
        description: 'Fixture product for review tests.',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 500_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });
  const productA = await makeProduct('a');
  const productB = await makeProduct('b');

  const buyerA1 = await registerUser(app, `e2e-review-a1-${suffix}@example.com`);
  const buyerA2 = await registerUser(app, `e2e-review-a2-${suffix}@example.com`);
  const buyerB = await registerUser(app, `e2e-review-b-${suffix}@example.com`);
  const stranger = await registerUser(app, `e2e-review-stranger-${suffix}@example.com`);
  const adminReg = await registerUser(app, `e2e-review-admin-${suffix}@example.com`);
  await client.user.update({ where: { id: adminReg.userId }, data: { role: 'ADMIN' } });
  const adminToken = await login(app, `e2e-review-admin-${suffix}@example.com`);

  const makeOrder = (userId: string, productId: string, status: 'PAID' | 'DELIVERED') =>
    client.order.create({
      data: {
        userId,
        status,
        currency: 'USD',
        totalAmount: 500_00,
        shipping: { fullName: 'Review Buyer', line1: 'Calle 1', city: 'Madrid', country: 'ES' },
        items: { create: [{ productId, qty: 1, unitPriceAmount: 500_00 }] },
      },
    });
  await makeOrder(buyerA1.userId, productA.id, 'PAID');
  await makeOrder(buyerA2.userId, productA.id, 'DELIVERED');
  await makeOrder(buyerB.userId, productB.id, 'PAID');

  return {
    app,
    prisma,
    suffix,
    brandId: brand.id,
    categoryId: category.id,
    productAId: productA.id,
    productBId: productB.id,
    buyerA1,
    buyerA2,
    buyerB,
    stranger,
    adminToken,
    adminId: adminReg.userId,
  };
}

async function destroyFixtures(fixture: Fixture): Promise<void> {
  const client = fixture.prisma as unknown as PrismaClient;
  await client.productReviewSummary.deleteMany({
    where: { productId: { in: [fixture.productAId, fixture.productBId] } },
  });
  await client.review.deleteMany({
    where: { productId: { in: [fixture.productAId, fixture.productBId] } },
  });
  await client.document.deleteMany({
    where: { productId: { in: [fixture.productAId, fixture.productBId] } },
  });
  await client.order.deleteMany({
    where: {
      userId: {
        in: [fixture.buyerA1.userId, fixture.buyerA2.userId, fixture.buyerB.userId],
      },
    },
  });
  await client.product.deleteMany({
    where: { id: { in: [fixture.productAId, fixture.productBId] } },
  });
  await client.brand.deleteMany({ where: { id: fixture.brandId } });
  await client.category.deleteMany({ where: { id: fixture.categoryId } });
  await client.user.deleteMany({
    where: {
      id: {
        in: [
          fixture.buyerA1.userId,
          fixture.buyerA2.userId,
          fixture.buyerB.userId,
          fixture.stranger.userId,
          fixture.adminId,
        ],
      },
    },
  });
  await fixture.app.close();
}

describe('Reviews (e2e)', () => {
  let fixture: Fixture;
  let reviewA1Id: string;

  beforeAll(async () => {
    fixture = await createFixtures();
  }, 60_000);

  afterAll(async () => {
    await destroyFixtures(fixture);
  });

  it('403s a user who never bought the product', async () => {
    await request(fixture.app.getHttpServer())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${fixture.stranger.token}`)
      .send({ productId: fixture.productAId, rating: 5, title: 'Nice', body: 'Looks good.' })
      .expect(403);
  });

  it('401s unauthenticated creation', async () => {
    await request(fixture.app.getHttpServer())
      .post('/api/v1/reviews')
      .send({ productId: fixture.productAId, rating: 5, title: 'Nice', body: 'Looks good.' })
      .expect(401);
  });

  it('creates a PENDING review for a buyer (not yet publicly listed)', async () => {
    const res = await request(fixture.app.getHttpServer())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${fixture.buyerA1.token}`)
      .send({
        productId: fixture.productAId,
        rating: 5,
        title: 'Great laptop',
        body: 'Fast and light, good battery.',
      })
      .expect(201);
    reviewA1Id = (res.body as { id: string }).id;
    expect(res.body).toMatchObject({ productId: fixture.productAId, verifiedPurchase: true });
    expect(res.body).not.toHaveProperty('userId');

    const list = await request(fixture.app.getHttpServer())
      .get(`/api/v1/reviews/product/${fixture.productAId}`)
      .expect(200);
    expect((list.body as { total: number }).total).toBe(0);
  });

  it('409s a second review of the same product by the same user', async () => {
    await request(fixture.app.getHttpServer())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${fixture.buyerA1.token}`)
      .send({ productId: fixture.productAId, rating: 4, title: 'Again', body: 'Second try.' })
      .expect(409);
  });

  it('403s CUSTOMER moderation and 401s anonymous moderation', async () => {
    await request(fixture.app.getHttpServer())
      .get('/api/v1/admin/reviews')
      .set('Authorization', `Bearer ${fixture.buyerA1.token}`)
      .expect(403);
    await request(fixture.app.getHttpServer()).get('/api/v1/admin/reviews').expect(401);
    await request(fixture.app.getHttpServer())
      .patch(`/api/v1/admin/reviews/${reviewA1Id}/status`)
      .set('Authorization', `Bearer ${fixture.buyerA1.token}`)
      .send({ status: 'PUBLISHED' })
      .expect(403);
  });

  it('publishes the review; it appears publicly but no summary below the minimum', async () => {
    await request(fixture.app.getHttpServer())
      .patch(`/api/v1/admin/reviews/${reviewA1Id}/status`)
      .set('Authorization', `Bearer ${fixture.adminToken}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    const list = await request(fixture.app.getHttpServer())
      .get(`/api/v1/reviews/product/${fixture.productAId}`)
      .expect(200);
    const body = list.body as { total: number; averageRating: number; data: { id: string }[] };
    expect(body.total).toBe(1);
    expect(body.averageRating).toBe(5);
    expect(body.data[0]?.id).toBe(reviewA1Id);

    // Only 1 published review with MIN=2: summary stays null.
    const summary = await request(fixture.app.getHttpServer())
      .get(`/api/v1/reviews/product/${fixture.productAId}/summary`)
      .expect(200);
    expect((summary.body as { summary: unknown }).summary).toBeNull();
  });

  it('shows the summary once published reviews reach the minimum', async () => {
    const created = await request(fixture.app.getHttpServer())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${fixture.buyerA2.token}`)
      .send({
        productId: fixture.productAId,
        rating: 4,
        title: 'Good value',
        body: 'Solid laptop, a bit heavy but reliable.',
      })
      .expect(201);
    const reviewA2Id = (created.body as { id: string }).id;
    await request(fixture.app.getHttpServer())
      .patch(`/api/v1/admin/reviews/${reviewA2Id}/status`)
      .set('Authorization', `Bearer ${fixture.adminToken}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);

    const summary = await request(fixture.app.getHttpServer())
      .get(`/api/v1/reviews/product/${fixture.productAId}/summary`)
      .expect(200);
    expect(summary.body).toMatchObject({
      summary: {
        productId: fixture.productAId,
        pros: ['Good battery life'],
        cons: ['A bit heavy'],
        basedOnCount: 2,
      },
    });
  });

  it('rejecting drops the review from the public list and removes the summary', async () => {
    await request(fixture.app.getHttpServer())
      .patch(`/api/v1/admin/reviews/${reviewA1Id}/status`)
      .set('Authorization', `Bearer ${fixture.adminToken}`)
      .send({ status: 'REJECTED' })
      .expect(200);

    const list = await request(fixture.app.getHttpServer())
      .get(`/api/v1/reviews/product/${fixture.productAId}`)
      .expect(200);
    expect((list.body as { total: number }).total).toBe(1);

    const summary = await request(fixture.app.getHttpServer())
      .get(`/api/v1/reviews/product/${fixture.productAId}/summary`)
      .expect(200);
    expect((summary.body as { summary: unknown }).summary).toBeNull();
  });

  it('lists PENDING reviews for admins with filters', async () => {
    // buyerB creates a PENDING review on product B.
    await request(fixture.app.getHttpServer())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${fixture.buyerB.token}`)
      .send({ productId: fixture.productBId, rating: 3, title: 'Fine', body: 'Does the job.' })
      .expect(201);

    const res = await request(fixture.app.getHttpServer())
      .get('/api/v1/admin/reviews?status=PENDING')
      .set('Authorization', `Bearer ${fixture.adminToken}`)
      .expect(200);
    const body = res.body as { total: number; data: { status: string; userId: string }[] };
    expect(body.total).toBeGreaterThanOrEqual(1);
    for (const entry of body.data) {
      expect(entry.status).toBe('PENDING');
      expect(typeof entry.userId).toBe('string');
    }
  });
});
