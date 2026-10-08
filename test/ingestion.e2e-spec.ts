import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { createTestApp } from './test-app.js';

/**
 * Product → SPEC_SHEET auto-ingest hook (e2e, see ADR 0019).
 *
 * No worker runs in e2e, so the auto document stays PENDING after the admin
 * write (the queue entry waits in Redis or the enqueue is skipped when Redis
 * is unreachable — both leave PENDING behind). The hook itself is
 * fire-and-forget, so assertions poll briefly instead of assuming write
 * ordering.
 */
describe('Ingestion product hook (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  let adminToken = '';
  let brandId = '';
  let categoryId = '';
  let productId = '';
  const createdUserIds: string[] = [];

  async function waitForDocument(productIdValue: string): Promise<{ id: string; status: string }> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const document = await prisma.document.findFirst({
        where: { productId: productIdValue, source: 'auto:product' },
        select: { id: true, status: true },
      });
      if (document !== null) {
        return document;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the auto SPEC_SHEET document');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const passwords = ctx.module.get(PasswordService);

    const adminEmail = `e2e-ing-admin-${suffix}@example.com`;
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

    const brand = await request(app.getHttpServer())
      .post('/api/v1/admin/brands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `E2E Ing Brand ${suffix}`, slug: `e2e-ing-brand-${suffix}` })
      .expect(201);
    brandId = (brand.body as { id: string }).id;

    const category = await request(app.getHttpServer())
      .post('/api/v1/admin/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `E2E Ing Category ${suffix}`, slug: `e2e-ing-cat-${suffix}` })
      .expect(201);
    categoryId = (category.body as { id: string }).id;
  });

  afterAll(async () => {
    await prisma.document.deleteMany({
      where: { productId, source: 'auto:product' },
    });
    if (productId !== '') {
      await prisma.product.deleteMany({ where: { id: productId } });
    }
    if (brandId !== '') {
      await prisma.brand.deleteMany({ where: { id: brandId } });
    }
    if (categoryId !== '') {
      await prisma.category.deleteMany({ where: { id: categoryId } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('creates one auto SPEC_SHEET document for an ACTIVE product', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sku: `E2E-ING-${suffix}`,
        name: `E2E Ing Product ${suffix}`,
        slug: `e2e-ing-product-${suffix}`,
        description: 'E2E ingestion fixture product',
        brandId,
        categoryId,
        priceAmount: 500_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
        prices: [],
        translations: [],
        images: [],
        initialStock: 3,
      })
      .expect(201);
    productId = (created.body as { id: string }).id;

    const document = await waitForDocument(productId);
    const row = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.type).toBe('SPEC_SHEET');
    expect(row.source).toBe('auto:product');
    expect(row.status).toBe('PENDING');
    expect(row.title).toContain(`E2E Ing Product ${suffix}`);
  });

  it('editing the product does not duplicate the auto document', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'E2E ingestion fixture product, revised edition' })
      .expect(200);

    // Give the fire-and-forget hook a moment, then assert uniqueness.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const count = await prisma.document.count({
      where: { productId, source: 'auto:product' },
    });
    expect(count).toBe(1);
  });

  it('archiving the product removes the auto document', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'ARCHIVED' })
      .expect(200);

    const deadline = Date.now() + 5000;
    for (;;) {
      const count = await prisma.document.count({
        where: { productId, source: 'auto:product' },
      });
      if (count === 0) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the auto document removal');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
});
