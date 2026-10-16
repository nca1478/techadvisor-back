import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { createTestApp } from './test-app.js';

interface AdminProductBody {
  id: string;
  sku: string;
  name: string;
  slug: string;
  status: string;
  priceAmount: number;
  currency: string;
  specs: Record<string, unknown>;
  prices: { currency: string; amount: number }[];
  translations: { locale: string; name: string; description: string }[];
  images: { url: string; alt: string | null; position: number }[];
  stock: number;
  reserved: number;
}

interface AdminOrderBody {
  id: string;
  userId: string;
  status: string;
  currency: string;
  totalAmount: number;
  items: { productId: string; qty: number; unitPriceAmount: number }[];
  statusHistory: { from: string | null; to: string; at: string }[];
}

/**
 * Assumes the local env: BASE_CURRENCY=USD, SUPPORTED_CURRENCIES=USD,EUR,
 * DEFAULT_LOCALE=en, SUPPORTED_LOCALES=en,es (backend/.env).
 *
 * All fixtures use run-unique `e2e-adm-` slugs/names and are removed in
 * `afterAll`, so the suite never mutates pre-existing rows. The order
 * driven to DELIVERED is moved PENDING_PAYMENT→PAID with a direct DB
 * update: in production only the Stripe webhook enters PAID (the admin
 * API rejects it with 422, asserted below).
 */
describe('Admin management (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwords: PasswordService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  const brandSlug = `e2e-adm-brand-${suffix}`;
  const catSlug = `e2e-adm-cat-${suffix}`;
  const productSlug = `e2e-adm-product-${suffix}`;
  const productSku = `E2E-ADM-${suffix}`;
  const draftSlug = `e2e-adm-draft-${suffix}`;

  let adminToken = '';
  let customerToken = '';
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  let brandId = '';
  let categoryId = '';
  let productId = '';
  let draftId = '';

  const shipping = {
    fullName: 'Ada Lovelace',
    line1: 'Calle Mayor 1, 2º B',
    city: 'Madrid',
    region: 'Madrid',
    postalCode: '28001',
    country: 'ES',
    phone: '+34 600 123 456',
  };

  function productPayload(overrides: Record<string, unknown> = {}) {
    return {
      sku: productSku,
      name: `E2E Admin Product ${suffix}`,
      slug: productSlug,
      description: `E2E admin fixture ${suffix}`,
      brandId,
      categoryId,
      priceAmount: 100_00,
      currency: 'USD',
      status: 'ACTIVE',
      specs: {},
      prices: [{ currency: 'EUR', amount: 90_00 }],
      translations: [
        {
          locale: 'es',
          name: `Producto admin E2E ${suffix}`,
          description: `Descripción admin E2E ${suffix}`,
        },
      ],
      images: [{ url: 'https://cdn.example.com/e2e/adm-1.jpg', alt: 'Front' }],
      initialStock: 5,
      ...overrides,
    };
  }

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    passwords = ctx.module.get(PasswordService);

    const adminEmail = `e2e-adm-admin-${suffix}@example.com`;
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
      .send({ email: `e2e-adm-customer-${suffix}@example.com`, password: 'long-enough-password' })
      .expect(201);
    customerToken = (registered.body as { tokens: { accessToken: string } }).tokens.accessToken;
    createdUserIds.push((registered.body as { user: { id: string } }).user.id);

    const brand = await request(app.getHttpServer())
      .post('/api/v1/admin/brands')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `E2E Adm Brand ${suffix}`, slug: brandSlug })
      .expect(201);
    brandId = (brand.body as { id: string }).id;

    const category = await request(app.getHttpServer())
      .post('/api/v1/admin/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `E2E Adm Category ${suffix}`, slug: catSlug })
      .expect(201);
    categoryId = (category.body as { id: string }).id;
  });

  afterAll(async () => {
    if (createdOrderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    const productIds = [productId, draftId].filter((id) => id.length > 0);
    if (productIds.length > 0) {
      // Inventory rows and movements cascade from the product delete.
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
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
    const routes: { method: 'get' | 'post' | 'patch' | 'put'; path: string; body?: object }[] = [
      { method: 'get', path: '/api/v1/admin/products' },
      { method: 'post', path: '/api/v1/admin/products', body: {} },
      { method: 'get', path: '/api/v1/admin/categories' },
      { method: 'get', path: '/api/v1/admin/categories/33333333-3333-4333-8333-333333333333' },
      { method: 'post', path: '/api/v1/admin/brands', body: {} },
      {
        method: 'patch',
        path: '/api/v1/admin/inventory/33333333-3333-4333-8333-333333333333',
        body: { delta: 1, reason: 'x' },
      },
      { method: 'get', path: '/api/v1/admin/orders' },
      {
        method: 'patch',
        path: '/api/v1/admin/orders/33333333-3333-4333-8333-333333333333/status',
        body: { status: 'PROCESSING' },
      },
    ];
    for (const route of routes) {
      await request(server)
        [route.method](route.path)
        .send(route.body ?? {})
        .expect(401);
      await request(server)
        [route.method](route.path)
        .set('Authorization', `Bearer ${customerToken}`)
        .send(route.body ?? {})
        .expect(403)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
        });
    }
  });

  it('creates brands and categories, rejects duplicates and unsafe deletes', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };

    // Duplicate brand slug -> 409; an unused brand deletes cleanly (204).
    // (Deleting a brand *in use* is asserted after product creation below.)
    await request(server)
      .post('/api/v1/admin/brands')
      .set(auth)
      .send({ name: `E2E Adm Brand ${suffix}`, slug: brandSlug })
      .expect(409);
    const spare = await request(server)
      .post('/api/v1/admin/brands')
      .set(auth)
      .send({ name: `E2E Adm Spare ${suffix}`, slug: `e2e-adm-spare-${suffix}` })
      .expect(201);
    await request(server)
      .delete(`/api/v1/admin/brands/${(spare.body as { id: string }).id}`)
      .set(auth)
      .expect(204);

    // Duplicate category slug -> 409; self-parent -> 400.
    await request(server)
      .post('/api/v1/admin/categories')
      .set(auth)
      .send({ name: `E2E Adm Category ${suffix}`, slug: catSlug })
      .expect(409);
    await request(server)
      .patch(`/api/v1/admin/categories/${categoryId}`)
      .set(auth)
      .send({ parentId: categoryId })
      .expect(400);

    // Get by id returns the same row; unknown ids 404 with the uniform payload.
    await request(server)
      .get(`/api/v1/admin/categories/${categoryId}`)
      .set(auth)
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ id: categoryId, slug: catSlug });
      });
    await request(server)
      .get('/api/v1/admin/categories/33333333-3333-4333-8333-333333333333')
      .set(auth)
      .expect(404)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      });

    // Category with products cannot be deleted (409) — asserted after
    // product creation below. An empty category deletes cleanly (204).
    const child = await request(server)
      .post('/api/v1/admin/categories')
      .set(auth)
      .send({ name: `E2E Adm Empty ${suffix}`, slug: `e2e-adm-empty-${suffix}` })
      .expect(201);
    await request(server)
      .delete(`/api/v1/admin/categories/${(child.body as { id: string }).id}`)
      .set(auth)
      .expect(204);
  });

  it('validates product writes (currency, prices, translations, specs, images)', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };

    // Base price must use BASE_CURRENCY (USD).
    await request(server)
      .post('/api/v1/admin/products')
      .set(auth)
      .send(productPayload({ sku: `X1-${productSku}`, slug: `x1-${productSlug}`, currency: 'EUR' }))
      .expect(400);
    // Overrides: no base-currency row, only supported currencies, no duplicates.
    for (const prices of [
      [{ currency: 'USD', amount: 100_00 }],
      [{ currency: 'GBP', amount: 80_00 }],
      [
        { currency: 'EUR', amount: 90_00 },
        { currency: 'EUR', amount: 91_00 },
      ],
    ]) {
      await request(server)
        .post('/api/v1/admin/products')
        .set(auth)
        .send(
          productPayload({
            sku: `X2-${productSku}-${prices[0]?.currency}`,
            slug: `x2-${prices[0]?.currency}-${productSlug}`,
            prices,
          }),
        )
        .expect(400);
    }
    // Translations: no default-locale row, only supported locales.
    await request(server)
      .post('/api/v1/admin/products')
      .set(auth)
      .send(
        productPayload({
          sku: `X3-${productSku}`,
          slug: `x3-${productSlug}`,
          translations: [{ locale: 'en', name: 'Dup', description: 'Dup' }],
        }),
      )
      .expect(400);
    // Specs: unknown keys are rejected for this category (empty schema).
    await request(server)
      .post('/api/v1/admin/products')
      .set(auth)
      .send(
        productPayload({
          sku: `X4-${productSku}`,
          slug: `x4-${productSlug}`,
          specs: { no_such_spec: 1 },
        }),
      )
      .expect(400);
    // Images: http URLs are rejected.
    await request(server)
      .post('/api/v1/admin/products')
      .set(auth)
      .send(
        productPayload({
          sku: `X5-${productSku}`,
          slug: `x5-${productSlug}`,
          images: [{ url: 'http://cdn.example.com/e2e/adm-plain.jpg' }],
        }),
      )
      .expect(400);
  });

  it('creates an ACTIVE product that appears in the public catalog', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };

    const created = await request(server)
      .post('/api/v1/admin/products')
      .set(auth)
      .send(productPayload())
      .expect(201);
    const product = created.body as AdminProductBody;
    productId = product.id;
    expect(product).toMatchObject({
      sku: productSku,
      slug: productSlug,
      status: 'ACTIVE',
      priceAmount: 100_00,
      currency: 'USD',
      stock: 5,
      reserved: 0,
    });
    expect(product.prices).toContainEqual({ currency: 'EUR', amount: 90_00 });
    expect(product.translations).toContainEqual({
      locale: 'es',
      name: `Producto admin E2E ${suffix}`,
      description: `Descripción admin E2E ${suffix}`,
    });
    expect(product.images).toEqual([
      { url: 'https://cdn.example.com/e2e/adm-1.jpg', alt: 'Front', position: 0 },
    ]);

    // Duplicate sku -> 409.
    await request(server)
      .post('/api/v1/admin/products')
      .set(auth)
      .send(productPayload({ slug: `other-${productSlug}` }))
      .expect(409);

    // Visible in the admin list (ACTIVE filter) and in the public catalog.
    const listed = await request(server)
      .get(`/api/v1/admin/products?status=ACTIVE&q=${encodeURIComponent(suffix)}`)
      .set(auth)
      .expect(200);
    expect((listed.body as { data: AdminProductBody[] }).data.map((row) => row.id)).toContain(
      productId,
    );
    const publicDetail = await request(server)
      .get(`/api/v1/catalog/products/${productSlug}`)
      .expect(200);
    expect(publicDetail.body).toMatchObject({ slug: productSlug, priceAmount: 100_00 });

    // A DRAFT product is visible to admins but hidden publicly.
    const draft = await request(server)
      .post('/api/v1/admin/products')
      .set(auth)
      .send(
        productPayload({
          sku: `DRAFT-${productSku}`,
          slug: draftSlug,
          name: `E2E Adm Draft ${suffix}`,
          status: 'DRAFT',
          prices: [],
          translations: [],
          images: [],
          initialStock: 0,
        }),
      )
      .expect(201);
    draftId = (draft.body as AdminProductBody).id;
    await request(server).get(`/api/v1/catalog/products/${draftSlug}`).expect(404);
    const drafts = await request(server)
      .get('/api/v1/admin/products?status=DRAFT')
      .set(auth)
      .expect(200);
    expect((drafts.body as { data: AdminProductBody[] }).data.map((row) => row.id)).toContain(
      draftId,
    );

    // Malformed id -> 400, unknown id -> 404.
    await request(server).get('/api/v1/admin/products/not-a-uuid').set(auth).expect(400);
    await request(server)
      .get('/api/v1/admin/products/33333333-3333-4333-8333-333333333333')
      .set(auth)
      .expect(404);
  });

  it('rejects deletes while the brand/category are referenced by products', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };

    await request(server)
      .delete(`/api/v1/admin/brands/${brandId}`)
      .set(auth)
      .expect(409)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      });
    await request(server)
      .delete(`/api/v1/admin/categories/${categoryId}`)
      .set(auth)
      .expect(409)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      });
  });

  it('checks out the product as a customer (reservation for later stock tests)', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ productId, qty: 1 })
      .expect(201);
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ shipping })
      .expect(201);
    const order = created.body as AdminOrderBody;
    createdOrderIds.push(order.id);
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', totalAmount: 100_00 });
  });

  it('replaces the image set transactionally (reorder, remove, invalid rejected)', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };
    const first = 'https://cdn.example.com/e2e/adm-1.jpg';
    const second = 'https://cdn.example.com/e2e/adm-2.jpg';

    const replaced = await request(server)
      .put(`/api/v1/admin/products/${productId}/images`)
      .set(auth)
      .send({ images: [{ url: second, alt: 'Back' }, { url: first }] })
      .expect(200);
    expect((replaced.body as AdminProductBody).images).toEqual([
      { url: second, alt: 'Back', position: 0 },
      { url: first, alt: null, position: 1 },
    ]);

    // The public API reflects the new order immediately.
    const publicDetail = await request(server)
      .get(`/api/v1/catalog/products/${productSlug}`)
      .expect(200);
    expect(
      (publicDetail.body as { images: { url: string; position: number }[] }).images.map(
        (image) => image.url,
      ),
    ).toEqual([second, first]);

    // Non-https URLs and >10 images are rejected with a clear error.
    await request(server)
      .put(`/api/v1/admin/products/${productId}/images`)
      .set(auth)
      .send({ images: [{ url: 'http://cdn.example.com/e2e/adm-plain.jpg' }] })
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
      });
    await request(server)
      .put(`/api/v1/admin/products/${productId}/images`)
      .set(auth)
      .send({
        images: Array.from({ length: 11 }, (_, index) => ({
          url: `https://cdn.example.com/e2e/adm-${String(index)}.jpg`,
        })),
      })
      .expect(400);
  });

  it('adjusts stock with an audit trail and guards invalid deltas', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };

    const before = (
      await request(server).get(`/api/v1/admin/inventory/${productId}`).set(auth).expect(200)
    ).body as { stock: number; reserved: number; available: number };
    expect(before).toMatchObject({ stock: 5, reserved: 1, available: 4 });

    const adjusted = await request(server)
      .patch(`/api/v1/admin/inventory/${productId}`)
      .set(auth)
      .send({ delta: 5, reason: `Restock for e2e ${suffix}` })
      .expect(200);
    expect(adjusted.body).toMatchObject({ productId, stock: 10, reserved: 1, available: 9 });
    const movementId = (adjusted.body as { movementId: string }).movementId;
    expect(typeof movementId).toBe('string');

    // The audit trail holds the creation row plus this adjustment.
    const movements = await request(server)
      .get(`/api/v1/admin/inventory/${productId}/movements`)
      .set(auth)
      .expect(200);
    const rows = movements.body as { delta: number; reason: string; stockAfter: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows).toContainEqual(
      expect.objectContaining({
        delta: 5,
        reason: `Restock for e2e ${suffix}`,
        stockAfter: 10,
      }),
    );

    // No-op, negative-stock and below-reserved adjustments are rejected.
    await request(server)
      .patch(`/api/v1/admin/inventory/${productId}`)
      .set(auth)
      .send({ delta: 0, reason: 'no-op' })
      .expect(400);
    await request(server)
      .patch(`/api/v1/admin/inventory/${productId}`)
      .set(auth)
      .send({ delta: -11, reason: 'too much' })
      .expect(400);
    await request(server)
      .patch(`/api/v1/admin/inventory/${productId}`)
      .set(auth)
      .send({ delta: -10, reason: 'below reserved' })
      .expect(409)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      });
  });

  it('filters the admin product list by stock level', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };
    // At this point the ACTIVE fixture holds available 9 (stock 10,
    // reserved 1) and the DRAFT fixture holds available 0 (stock 0,
    // reserved 0). Other pre-existing rows may exist, so assertions are
    // membership-based plus a universal invariant per filter.
    const out = await request(server)
      .get('/api/v1/admin/products?stock=out_of_stock')
      .set(auth)
      .expect(200);
    const outRows = (out.body as { data: AdminProductBody[] }).data;
    expect(outRows.map((row) => row.id)).toContain(draftId);
    expect(outRows.map((row) => row.id)).not.toContain(productId);
    for (const row of outRows) {
      expect(row.stock - row.reserved).toBeLessThanOrEqual(0);
    }

    const low = await request(server)
      .get('/api/v1/admin/products?stock=low_stock')
      .set(auth)
      .expect(200);
    const lowRows = (low.body as { data: AdminProductBody[] }).data;
    expect(lowRows.map((row) => row.id)).toContain(draftId);
    expect(lowRows.map((row) => row.id)).not.toContain(productId);
    for (const row of lowRows) {
      expect(row.stock - row.reserved).toBeLessThanOrEqual(5);
    }

    const reserved = await request(server)
      .get('/api/v1/admin/products?stock=reserved')
      .set(auth)
      .expect(200);
    const reservedRows = (reserved.body as { data: AdminProductBody[] }).data;
    expect(reservedRows.map((row) => row.id)).toContain(productId);
    expect(reservedRows.map((row) => row.id)).not.toContain(draftId);
    for (const row of reservedRows) {
      expect(row.reserved).toBeGreaterThan(0);
    }

    // Unknown filter values are rejected.
    await request(server).get('/api/v1/admin/products?stock=foo').set(auth).expect(400);
  });

  it('lists admin products in alphabetical order by name', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };
    // Both fixtures share the run-unique suffix, so the search isolates
    // them: `E2E Adm Draft …` must come before `E2E Admin Product …`.
    const listed = await request(server)
      .get(`/api/v1/admin/products?q=${encodeURIComponent(suffix)}`)
      .set(auth)
      .expect(200);
    const names = (listed.body as { data: AdminProductBody[] }).data.map((row) => row.name);
    expect(names).toEqual([`E2E Adm Draft ${suffix}`, `E2E Admin Product ${suffix}`]);
  });

  it('archives the product: hidden publicly, kept in order history', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };

    const archived = await request(server)
      .patch(`/api/v1/admin/products/${productId}/status`)
      .set(auth)
      .send({ status: 'ARCHIVED' })
      .expect(200);
    expect((archived.body as AdminProductBody).status).toBe('ARCHIVED');

    // Gone from the public catalog…
    await request(server).get(`/api/v1/catalog/products/${productSlug}`).expect(404);
    const publicList = await request(server)
      .get(`/api/v1/catalog/products?q=${encodeURIComponent(`E2E Admin Product ${suffix}`)}`)
      .expect(200);
    expect((publicList.body as { data: unknown[] }).data).toEqual([]);

    // …but still listed for admins and present in the historical order.
    const adminList = await request(server)
      .get('/api/v1/admin/products?status=ARCHIVED')
      .set(auth)
      .expect(200);
    expect((adminList.body as { data: AdminProductBody[] }).data.map((row) => row.id)).toContain(
      productId,
    );
    const order = await request(server)
      .get(`/api/v1/admin/orders/${createdOrderIds[0]}`)
      .set(auth)
      .expect(200);
    expect((order.body as AdminOrderBody).items[0]).toMatchObject({
      productId,
      qty: 1,
      unitPriceAmount: 100_00,
    });
  });

  it('lists orders with filters and walks the fulfillment chain', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${adminToken}` };
    const orderId = createdOrderIds[0];

    const listed = await request(server).get('/api/v1/admin/orders').set(auth).expect(200);
    expect((listed.body as { data: AdminOrderBody[] }).data.map((row) => row.id)).toContain(
      orderId,
    );
    const pending = await request(server)
      .get('/api/v1/admin/orders?status=PENDING_PAYMENT')
      .set(auth)
      .expect(200);
    expect((pending.body as { data: AdminOrderBody[] }).data.map((row) => row.id)).toContain(
      orderId,
    );
    const inRange = await request(server)
      .get('/api/v1/admin/orders?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z')
      .set(auth)
      .expect(200);
    expect((inRange.body as { data: AdminOrderBody[] }).data.map((row) => row.id)).toContain(
      orderId,
    );
    const outOfRange = await request(server)
      .get('/api/v1/admin/orders?from=2100-01-01T00:00:00.000Z')
      .set(auth)
      .expect(200);
    expect((outOfRange.body as { data: unknown[] }).data).toEqual([]);
    await request(server).get('/api/v1/admin/orders?from=not-a-date').set(auth).expect(400);

    // Skipping states and entering PAID are rejected (422).
    await request(server)
      .patch(`/api/v1/admin/orders/${orderId}/status`)
      .set(auth)
      .send({ status: 'SHIPPED' })
      .expect(422);
    await request(server)
      .patch(`/api/v1/admin/orders/${orderId}/status`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(422)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 422, code: 'UNPROCESSABLE_ENTITY' });
      });

    // Simulate the Stripe webhook, then walk PAID→PROCESSING→SHIPPED→DELIVERED.
    await prisma.order.update({ where: { id: orderId }, data: { status: 'PAID' } });
    for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) {
      const moved = await request(server)
        .patch(`/api/v1/admin/orders/${orderId}/status`)
        .set(auth)
        .send({ status })
        .expect(200);
      expect((moved.body as AdminOrderBody).status).toBe(status);
    }
    // DELIVERED is terminal.
    await request(server)
      .patch(`/api/v1/admin/orders/${orderId}/status`)
      .set(auth)
      .send({ status: 'PROCESSING' })
      .expect(422);

    // Every admin transition recorded its date/time in the status history:
    // the initial entry plus PAID→PROCESSING→SHIPPED→DELIVERED (PAID itself
    // was entered with a direct DB update, like the production webhook
    // would, so it has no history row of its own).
    const detail = await request(server)
      .get(`/api/v1/admin/orders/${orderId}`)
      .set(auth)
      .expect(200);
    const history = (detail.body as AdminOrderBody).statusHistory;
    expect(history[0]).toMatchObject({ from: null, to: 'PENDING_PAYMENT' });
    expect(history.slice(-3).map((entry) => entry.to)).toEqual([
      'PROCESSING',
      'SHIPPED',
      'DELIVERED',
    ]);
    for (const entry of history) {
      expect(new Date(entry.at).toString()).not.toBe('Invalid Date');
    }

    // Customer search: the run-unique email fragment matches, anything
    // else matches nothing.
    const byCustomer = await request(server)
      .get(`/api/v1/admin/orders?q=${encodeURIComponent(`e2e-adm-customer-${suffix}`)}`)
      .set(auth)
      .expect(200);
    expect((byCustomer.body as { data: AdminOrderBody[] }).data.map((row) => row.id)).toContain(
      orderId,
    );
    const noMatch = await request(server)
      .get('/api/v1/admin/orders?q=nobody-matches-this-customer')
      .set(auth)
      .expect(200);
    expect((noMatch.body as { data: unknown[] }).data).toEqual([]);

    const delivered = await request(server)
      .get('/api/v1/admin/orders?status=DELIVERED')
      .set(auth)
      .expect(200);
    expect((delivered.body as { data: AdminOrderBody[] }).data.map((row) => row.id)).toContain(
      orderId,
    );
    await request(server)
      .get('/api/v1/admin/orders/33333333-3333-4333-8333-333333333333')
      .set(auth)
      .expect(404);
  });
});
