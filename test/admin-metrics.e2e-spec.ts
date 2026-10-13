import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { createTestApp } from './test-app.js';

interface OverviewBody {
  from: string;
  to: string;
  granularity: string;
  ordersTotal: number;
  byStatus: { status: string; count: number }[];
  revenue: { currency: string; amount: number; count: number }[];
  bucketCurrency: string | null;
  buckets: { key: string; amount: number }[];
  attention: {
    outOfStock: number;
    lowStock: number;
    pendingReviews: number;
    failedDocs: number;
    openUnanswered: number;
  };
}

/**
 * Fixtures use a fixed 2024 window so range-scoped assertions are exact even
 * against a seeded dev database: nothing else lives on 2024-05-06.
 * Attention counts assert `>= 1` (my fixture row) because seed data may add
 * more. PAID orders are written directly: in production only the Stripe
 * webhook enters PAID. Everything created here is removed in `afterAll`.
 */
describe('Admin metrics overview (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  const day = '2024-05-06';
  const range = { from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.000Z` };

  let adminToken = '';
  let customerToken = '';
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  let brandId = '';
  let categoryId = '';
  let productId = '';

  const shipping = {
    fullName: 'Ada Lovelace',
    line1: 'Calle Mayor 1',
    city: 'Madrid',
    country: 'ES',
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const passwords = ctx.module.get(PasswordService);

    const adminEmail = `e2e-metrics-admin-${suffix}@example.com`;
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
      .send({
        email: `e2e-metrics-customer-${suffix}@example.com`,
        password: 'long-enough-password',
      })
      .expect(201);
    customerToken = (registered.body as { tokens: { accessToken: string } }).tokens.accessToken;
    const customerId = (registered.body as { user: { id: string } }).user.id;
    createdUserIds.push(customerId);

    const brand = await request(app.getHttpServer())
      .post('/api/v1/admin/brands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `E2E Metrics Brand ${suffix}`, slug: `e2e-metrics-brand-${suffix}` })
      .expect(201);
    brandId = (brand.body as { id: string }).id;
    const category = await request(app.getHttpServer())
      .post('/api/v1/admin/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `E2E Metrics Category ${suffix}`, slug: `e2e-metrics-cat-${suffix}` })
      .expect(201);
    categoryId = (category.body as { id: string }).id;
    // No initialStock: stock 0 makes this product out-of-stock by design.
    const product = await request(app.getHttpServer())
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: `E2E-METRICS-${suffix}`,
        name: `E2E Metrics Product ${suffix}`,
        slug: `e2e-metrics-product-${suffix}`,
        description: `E2E metrics fixture ${suffix}`,
        brandId,
        categoryId,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      })
      .expect(201);
    productId = (product.body as { id: string }).id;

    const orders = await prisma.$transaction([
      prisma.order.create({
        data: {
          userId: customerId,
          status: 'PAID',
          currency: 'USD',
          totalAmount: 45_000,
          shipping,
          createdAt: new Date(`${day}T10:00:00.000Z`),
        },
        select: { id: true },
      }),
      prisma.order.create({
        data: {
          userId: customerId,
          status: 'PAID',
          currency: 'USD',
          totalAmount: 20_000,
          shipping,
          createdAt: new Date(`${day}T11:00:00.000Z`),
        },
        select: { id: true },
      }),
      prisma.order.create({
        data: {
          userId: customerId,
          status: 'CANCELLED',
          currency: 'USD',
          totalAmount: 99_900,
          shipping,
          createdAt: new Date(`${day}T12:00:00.000Z`),
        },
        select: { id: true },
      }),
    ]);
    createdOrderIds.push(...orders.map((order) => order.id));

    await prisma.review.create({
      data: {
        productId,
        userId: customerId,
        rating: 5,
        title: `Metrics fixture ${suffix}`,
        body: 'Great product for the metrics fixture.',
        status: 'PENDING',
      },
    });
    await prisma.document.create({
      data: {
        type: 'MANUAL',
        title: `E2E Metrics Doc ${suffix}`,
        locale: 'en',
        contentHash: `metrics-${suffix}`,
        status: 'FAILED',
        error: 'fixture failure',
      },
    });
    await prisma.unansweredQuery.create({
      data: { query: `E2E metrics question ${suffix}?`, reason: 'no_evidence', status: 'NEW' },
    });
  });

  afterAll(async () => {
    await prisma.review.deleteMany({ where: { productId } });
    await prisma.document.deleteMany({ where: { contentHash: `metrics-${suffix}` } });
    await prisma.unansweredQuery.deleteMany({
      where: { query: `E2E metrics question ${suffix}?` },
    });
    if (createdOrderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (productId.length > 0) {
      await prisma.product.deleteMany({ where: { id: productId } });
    }
    if (brandId.length > 0) {
      await prisma.brand.deleteMany({ where: { id: brandId } });
    }
    if (categoryId.length > 0) {
      await prisma.category.deleteMany({ where: { id: categoryId } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('requires authentication (401 without token, 403 for CUSTOMER)', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/v1/admin/metrics/overview').expect(401);
    await request(server)
      .get('/api/v1/admin/metrics/overview')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(403)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      });
  });

  it('rejects invalid ranges (bad date, from after to, bad granularity)', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };
    await request(server)
      .get('/api/v1/admin/metrics/overview?from=not-a-date')
      .set(auth)
      .expect(400);
    await request(server)
      .get(`/api/v1/admin/metrics/overview?from=${range.to}&to=${range.from}`)
      .set(auth)
      .expect(400);
    await request(server)
      .get('/api/v1/admin/metrics/overview?granularity=month')
      .set(auth)
      .expect(400);
  });

  it('aggregates the fixture window exactly (day granularity)', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .get(`/api/v1/admin/metrics/overview?from=${range.from}&to=${range.to}&granularity=day`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as OverviewBody;
    expect(body.ordersTotal).toBe(3);
    expect(body.byStatus).toEqual([
      { status: 'CANCELLED', count: 1 },
      { status: 'PAID', count: 2 },
    ]);
    expect(body.revenue).toEqual([{ currency: 'USD', amount: 65_000, count: 2 }]);
    expect(body.bucketCurrency).toBe('USD');
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0]).toEqual({ key: `${day}T00:00:00.000Z`, amount: 65_000 });
    expect(body.attention.outOfStock).toBeGreaterThanOrEqual(1);
    expect(body.attention.lowStock).toBeGreaterThanOrEqual(1);
    expect(body.attention.pendingReviews).toBeGreaterThanOrEqual(1);
    expect(body.attention.failedDocs).toBeGreaterThanOrEqual(1);
    expect(body.attention.openUnanswered).toBeGreaterThanOrEqual(1);
  });

  it('buckets the same window by hour', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .get(`/api/v1/admin/metrics/overview?from=${range.from}&to=${range.to}&granularity=hour`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as OverviewBody;
    expect(body.buckets).toHaveLength(24);
    expect(body.buckets[10]).toEqual({ key: `${day}T10:00:00.000Z`, amount: 45_000 });
    expect(body.buckets[11]).toEqual({ key: `${day}T11:00:00.000Z`, amount: 20_000 });
    expect(body.buckets[0]).toEqual({ key: `${day}T00:00:00.000Z`, amount: 0 });
  });

  it('defaults to the last 7 days with empty buckets when nothing collected', async () => {
    const server = app.getHttpServer();
    const res = await request(server)
      .get('/api/v1/admin/metrics/overview')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as OverviewBody;
    expect(body.granularity).toBe('day');
    expect(body.buckets).toHaveLength(7);
    expect(typeof body.ordersTotal).toBe('number');
    expect(body.from).toMatch(/T00:00:00\.000Z$/);
  });
});
