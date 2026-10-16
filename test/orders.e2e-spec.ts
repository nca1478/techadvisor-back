import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { OrdersExpirationService } from '../src/modules/orders/orders-expiration.service.js';
import { createTestApp } from './test-app.js';

interface OrderItemBody {
  productId: string;
  name: string;
  slug: string;
  qty: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
}

interface OrderBody {
  id: string;
  status: string;
  currency: string;
  totalAmount: number;
  itemCount: number;
  shipping: Record<string, unknown>;
  items: OrderItemBody[];
  statusHistory: { from: string | null; to: string; at: string }[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Assumes the local env: BASE_CURRENCY=USD, SUPPORTED_CURRENCIES=USD,EUR,
 * DEFAULT_LOCALE=en (backend/.env).
 *
 * Fixtures use run-unique `e2e-ord-` slugs. PA (stock 10, EUR override),
 * PB (stock 1, for the race test), PC (stock 5, for the expiry test).
 * Orders cascade-delete with their items; users/carts/products are removed
 * afterwards, so the suite never mutates pre-existing rows.
 */
describe('Orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let expiration: OrdersExpirationService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  const brandSlug = `e2e-ord-brand-${suffix}`;
  const catSlug = `e2e-ord-cat-${suffix}`;
  const paSlug = `e2e-ord-pa-${suffix}`;
  const pbSlug = `e2e-ord-pb-${suffix}`;
  const pcSlug = `e2e-ord-pc-${suffix}`;

  let productAId = '';
  let productBId = '';
  let productCId = '';
  let brandId = '';
  let categoryId = '';
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  const shipping = {
    fullName: 'Ada Lovelace',
    line1: 'Calle Mayor 1, 2º B',
    city: 'Madrid',
    region: 'Madrid',
    postalCode: '28001',
    country: 'ES',
    phone: '+34 600 123 456',
  };

  async function register(emailPrefix: string): Promise<{ userId: string; token: string }> {
    const email = `e2e-ord-${emailPrefix}-${suffix}@example.com`;
    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'long-enough-password' })
      .expect(201);
    const userId = (registered.body as { user: { id: string } }).user.id;
    const token = (registered.body as { tokens: { accessToken: string } }).tokens.accessToken;
    createdUserIds.push(userId);
    return { userId, token };
  }

  async function addToCart(token: string, productId: string, qty: number): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId, qty })
      .expect(201);
  }

  async function reserved(productId: string): Promise<{ stock: number; reserved: number }> {
    const row = await prisma.inventory.findUniqueOrThrow({ where: { productId } });
    return { stock: row.stock, reserved: row.reserved };
  }

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    expiration = ctx.module.get(OrdersExpirationService);

    const brand = await prisma.brand.create({
      data: { name: `E2E Ord Brand ${suffix}`, slug: brandSlug },
    });
    brandId = brand.id;
    const category = await prisma.category.create({
      data: { name: `E2E Ord Category ${suffix}`, slug: catSlug },
    });
    categoryId = category.id;

    const pa = await prisma.product.create({
      data: {
        sku: `E2E-ORD-PA-${suffix}`,
        name: `E2E Ord Product A ${suffix}`,
        slug: paSlug,
        description: 'orders fixture A',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
        prices: { create: [{ currency: 'EUR', amount: 90_00 }] },
        images: {
          create: [{ url: 'https://cdn.example.com/e2e/ord-a-front.jpg', alt: null, position: 0 }],
        },
        inventory: { create: { stock: 10, reserved: 0 } },
      },
    });
    const pb = await prisma.product.create({
      data: {
        sku: `E2E-ORD-PB-${suffix}`,
        name: `E2E Ord Product B ${suffix}`,
        slug: pbSlug,
        description: 'orders fixture B',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 50_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
        inventory: { create: { stock: 1, reserved: 0 } },
      },
    });
    const pc = await prisma.product.create({
      data: {
        sku: `E2E-ORD-PC-${suffix}`,
        name: `E2E Ord Product C ${suffix}`,
        slug: pcSlug,
        description: 'orders fixture C',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 30_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
        inventory: { create: { stock: 5, reserved: 0 } },
      },
    });
    productAId = pa.id;
    productBId = pb.id;
    productCId = pc.id;
  });

  afterAll(async () => {
    if (createdOrderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdUserIds.length > 0) {
      // Carts cascade from the user delete.
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.product.deleteMany({
      where: { id: { in: [productAId, productBId, productCId] } },
    });
    await prisma.brand.deleteMany({ where: { id: brandId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await app.close();
  });

  it('requires authentication on every route', async () => {
    const server = app.getHttpServer();
    await request(server).post('/api/v1/orders').send({ shipping }).expect(401);
    await request(server).get('/api/v1/orders').expect(401);
    await request(server).get('/api/v1/orders/33333333-3333-4333-8333-333333333333').expect(401);
    await request(server)
      .post('/api/v1/orders/33333333-3333-4333-8333-333333333333/cancel')
      .expect(401);
  });

  it('rejects invalid shipping addresses (400) and malformed ids (400)', async () => {
    const { token } = await register('addr');
    const server = app.getHttpServer();

    await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ shipping: { ...shipping, country: 'ESP' } })
      .expect(400);
    await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ shipping: { ...shipping, line1: '' } })
      .expect(400);
    await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
    await request(server)
      .get('/api/v1/orders/not-a-uuid')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('rejects checkout from an empty cart (422)', async () => {
    const { token } = await register('empty');
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ shipping })
      .expect(422)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 422, code: 'UNPROCESSABLE_ENTITY' });
      });
  });

  it('creates an order from the cart: frozen prices, reserved stock, emptied cart', async () => {
    const { token } = await register('happy');
    const server = app.getHttpServer();
    await addToCart(token, productAId, 2);
    await addToCart(token, productCId, 1);

    const res = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ shipping })
      .expect(201);
    const order = res.body as OrderBody;
    createdOrderIds.push(order.id);

    expect(order).toMatchObject({
      status: 'PENDING_PAYMENT',
      currency: 'USD',
      // 2 × 100_00 (PA) + 1 × 30_00 (PC), computed server-side from the DB.
      totalAmount: 230_00,
      itemCount: 3,
      shipping: { ...shipping, country: 'ES' },
    });
    // Creation records the initial status-history entry with its date/time.
    expect(order.statusHistory).toHaveLength(1);
    expect(order.statusHistory[0]).toMatchObject({ from: null, to: 'PENDING_PAYMENT' });
    expect(new Date(order.statusHistory[0].at).toString()).not.toBe('Invalid Date');
    expect(order.items).toHaveLength(2);
    const byId = new Map(order.items.map((item) => [item.productId, item]));
    expect(byId.get(productAId)).toMatchObject({
      qty: 2,
      unitPriceAmount: 100_00,
      lineTotalAmount: 200_00,
      slug: paSlug,
    });
    expect(byId.get(productCId)).toMatchObject({
      qty: 1,
      unitPriceAmount: 30_00,
      lineTotalAmount: 30_00,
    });

    // Stock is reserved (physical stock untouched), the cart is empty.
    expect(await reserved(productAId)).toMatchObject({ stock: 10, reserved: 2 });
    expect(await reserved(productCId)).toMatchObject({ stock: 5, reserved: 1 });
    const cart = await request(server)
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(cart.body).toMatchObject({ items: [], totalAmount: 0, itemCount: 0 });
  });

  it('resolves the EUR price override into the frozen order currency', async () => {
    const { token } = await register('eur');
    await addToCart(token, productAId, 1);

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders?currency=EUR')
      .set('Authorization', `Bearer ${token}`)
      .send({ shipping })
      .expect(201);
    const order = res.body as OrderBody;
    createdOrderIds.push(order.id);

    expect(order).toMatchObject({ currency: 'EUR', totalAmount: 90_00, itemCount: 1 });
    expect(order.items[0]).toMatchObject({ productId: productAId, unitPriceAmount: 90_00 });

    // Release the reservation through the API so later tests see clean stock.
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(await reserved(productAId)).toMatchObject({ stock: 10, reserved: 2 });
  });

  it('fails checkout with 409 when stock vanished after the cart was filled', async () => {
    const { token } = await register('race');
    // PB has stock 1: filling the cart succeeds while it is still available.
    await addToCart(token, productBId, 1);
    // A concurrent checkout reserves the only unit before we place our order.
    await prisma.inventory.update({ where: { productId: productBId }, data: { reserved: 1 } });

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ shipping })
      .expect(409)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      });

    // Our cart is untouched (no partial order was created).
    const cart = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((cart.body as { itemCount: number }).itemCount).toBe(1);

    await prisma.inventory.update({ where: { productId: productBId }, data: { reserved: 0 } });
  });

  it('lists and details only the caller’s own orders', async () => {
    const first = await register('owner');
    const second = await register('other');
    const server = app.getHttpServer();
    await addToCart(first.token, productCId, 1);
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${first.token}`)
      .send({ shipping })
      .expect(201);
    const order = created.body as OrderBody;
    createdOrderIds.push(order.id);

    const listed = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${first.token}`)
      .expect(200);
    expect((listed.body as OrderBody[]).map((row) => row.id)).toContain(order.id);

    const detailed = await request(server)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${first.token}`)
      .expect(200);
    expect(detailed.body as OrderBody).toMatchObject({ id: order.id, status: 'PENDING_PAYMENT' });

    // Another user sees nothing: same 404 as for unknown ids.
    await request(server)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${second.token}`)
      .expect(404);
    await request(server)
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${second.token}`)
      .expect(404);
    await request(server)
      .get('/api/v1/orders/33333333-3333-4333-8333-333333333333')
      .set('Authorization', `Bearer ${first.token}`)
      .expect(404);

    // The other user's list is empty.
    const empty = await request(server)
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${second.token}`)
      .expect(200);
    expect(empty.body as OrderBody[]).toEqual([]);
  });

  it('cancelling a PENDING_PAYMENT order releases the reservation; repeats are 422', async () => {
    const { token } = await register('cancel');
    const server = app.getHttpServer();
    const before = await reserved(productCId);
    await addToCart(token, productCId, 2);
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ shipping })
      .expect(201);
    const order = created.body as OrderBody;
    createdOrderIds.push(order.id);
    expect(await reserved(productCId)).toMatchObject({ reserved: before.reserved + 2 });

    const cancelled = await request(server)
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(cancelled.body as OrderBody).toMatchObject({ id: order.id, status: 'CANCELLED' });
    // The cancellation appended a dated history entry after the initial one.
    const cancelledHistory = (cancelled.body as OrderBody).statusHistory;
    expect(cancelledHistory).toHaveLength(2);
    expect(cancelledHistory[1]).toMatchObject({ from: 'PENDING_PAYMENT', to: 'CANCELLED' });
    expect(new Date(cancelledHistory[1].at).toString()).not.toBe('Invalid Date');
    expect(await reserved(productCId)).toMatchObject({
      stock: before.stock,
      reserved: before.reserved,
    });

    // Cancelling a CANCELLED order is an invalid transition (domain error).
    await request(server)
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(422)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 422, code: 'UNPROCESSABLE_ENTITY' });
      });
  });

  it('expires PENDING_PAYMENT orders older than 30 minutes and releases stock', async () => {
    const { token } = await register('expiry');
    const server = app.getHttpServer();
    await addToCart(token, productCId, 1);
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ shipping })
      .expect(201);
    const order = created.body as OrderBody;
    createdOrderIds.push(order.id);
    const before = await reserved(productCId);

    // Fresh orders are not expired.
    await expect(expiration.expirePendingOrders()).resolves.toBe(0);

    // Backdate past the TTL and sweep: the order is cancelled, stock released.
    await prisma.order.update({
      where: { id: order.id },
      data: { createdAt: new Date(Date.now() - 31 * 60 * 1000) },
    });
    await expect(expiration.expirePendingOrders()).resolves.toBe(1);

    const detail = await request(server)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body as OrderBody).toMatchObject({ status: 'CANCELLED' });
    expect(await reserved(productCId)).toMatchObject({
      stock: before.stock,
      reserved: before.reserved - 1,
    });
  });
});
