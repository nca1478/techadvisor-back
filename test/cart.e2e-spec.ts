import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

interface CartItemBody {
  productId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  unitPriceAmount: number;
  qty: number;
  lineTotalAmount: number;
  inStock: boolean;
  sufficientStock: boolean;
  availableQuantity: number;
}

interface CartBody {
  id: string;
  currency: string;
  locale: string;
  items: CartItemBody[];
  totalAmount: number;
  itemCount: number;
}

/**
 * Assumes the local env: BASE_CURRENCY=USD, SUPPORTED_CURRENCIES=USD,EUR,
 * DEFAULT_LOCALE=en (backend/.env).
 *
 * Fixtures use run-unique `e2e-cart-` slugs; carts are tracked by response id
 * and removed afterwards, so the suite never mutates pre-existing rows.
 * PA (stock 5, EUR override, one image), PB (stock 2, no image), PC
 * (stock 1, for the merge-cap case).
 */
describe('Cart (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  const brandSlug = `e2e-cart-brand-${suffix}`;
  const catSlug = `e2e-cart-cat-${suffix}`;
  const paSlug = `e2e-cart-pa-${suffix}`;
  const pbSlug = `e2e-cart-pb-${suffix}`;
  const pcSlug = `e2e-cart-pc-${suffix}`;

  let productAId = '';
  let productBId = '';
  let productCId = '';
  let brandId = '';
  let categoryId = '';
  const createdUserIds: string[] = [];
  const seenCartIds = new Set<string>();
  const seenSessionIds = new Set<string>();

  function trackCart(res: { body: CartBody }): CartBody {
    seenCartIds.add(res.body.id);
    return res.body;
  }

  /** Extracts the `sid=<value>` pair from a Set-Cookie response header. */
  function sidPair(res: { headers: { 'set-cookie'?: string[] } }): string {
    return res.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
  }

  /** Records the guest session id issued (or reused) by a response. */
  function noteSid(res: { headers: { 'set-cookie'?: string[] } }): void {
    const pair = sidPair(res);
    const value = pair.startsWith('sid=') ? pair.slice('sid='.length) : '';
    const sessionId = value.split('.')[0];
    if (sessionId) {
      seenSessionIds.add(sessionId);
    }
  }

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);

    const brand = await prisma.brand.create({
      data: { name: `E2E Cart Brand ${suffix}`, slug: brandSlug },
    });
    brandId = brand.id;
    const category = await prisma.category.create({
      data: { name: `E2E Cart Category ${suffix}`, slug: catSlug },
    });
    categoryId = category.id;

    const pa = await prisma.product.create({
      data: {
        sku: `E2E-CART-PA-${suffix}`,
        name: `E2E Cart Product A ${suffix}`,
        slug: paSlug,
        description: 'cart fixture A',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
        prices: { create: [{ currency: 'EUR', amount: 90_00 }] },
        images: {
          create: [{ url: 'https://cdn.example.com/e2e/cart-a-front.jpg', alt: null, position: 0 }],
        },
        inventory: { create: { stock: 5, reserved: 0 } },
      },
    });
    const pb = await prisma.product.create({
      data: {
        sku: `E2E-CART-PB-${suffix}`,
        name: `E2E Cart Product B ${suffix}`,
        slug: pbSlug,
        description: 'cart fixture B',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 50_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
        inventory: { create: { stock: 2, reserved: 0 } },
      },
    });
    const pc = await prisma.product.create({
      data: {
        sku: `E2E-CART-PC-${suffix}`,
        name: `E2E Cart Product C ${suffix}`,
        slug: pcSlug,
        description: 'cart fixture C',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 30_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
        inventory: { create: { stock: 1, reserved: 0 } },
      },
    });
    productAId = pa.id;
    productBId = pb.id;
    productCId = pc.id;
  });

  afterAll(async () => {
    // Every cart touched by this suite: guest carts by session id, user (and
    // any other leftover) carts by id. Items cascade from the cart delete.
    if (seenSessionIds.size > 0) {
      await prisma.cart.deleteMany({ where: { sessionId: { in: [...seenSessionIds] } } });
    }
    if (seenCartIds.size > 0) {
      await prisma.cart.deleteMany({ where: { id: { in: [...seenCartIds] } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.product.deleteMany({
      where: { id: { in: [productAId, productBId, productCId] } },
    });
    await prisma.brand.deleteMany({ where: { id: brandId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await app.close();
  });

  it('guest GET /cart returns an empty cart and issues an httpOnly sid cookie', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/cart').expect(200);
    const cart = trackCart(res);
    noteSid(res);
    expect(cart).toMatchObject({
      currency: 'USD',
      locale: 'en',
      items: [],
      totalAmount: 0,
      itemCount: 0,
    });
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie?.join(';')).toMatch(/sid=[^;]+;.*HttpOnly/i);
  });

  it('guest cart is isolated per sid and priced from the database', async () => {
    const guest = request.agent(app.getHttpServer());
    const other = request.agent(app.getHttpServer());

    // Client-sent money is ignored (stripped by validation, totals from DB).
    const added = await guest
      .post('/api/v1/cart/items')
      .send({ productId: productAId, qty: 2, unitPriceAmount: 1, totalAmount: 1 })
      .expect(201);
    const cart = trackCart(added);
    noteSid(added);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toMatchObject({
      productId: productAId,
      name: `E2E Cart Product A ${suffix}`,
      imageUrl: 'https://cdn.example.com/e2e/cart-a-front.jpg',
      unitPriceAmount: 100_00,
      qty: 2,
      lineTotalAmount: 200_00,
      inStock: true,
      sufficientStock: true,
    });
    expect(cart).toMatchObject({ totalAmount: 200_00, itemCount: 2 });

    // A second guest sees an empty cart: sessions are isolated.
    const empty = await other.get('/api/v1/cart').expect(200);
    trackCart(empty);
    expect((empty.body as CartBody).items).toHaveLength(0);

    // Adding to the cart does not reserve stock.
    const inv = await prisma.inventory.findUnique({ where: { productId: productAId } });
    expect(inv).toMatchObject({ stock: 5, reserved: 0 });
  });

  it('PATCH sets the quantity; DELETE removes the line (idempotent)', async () => {
    const guest = request.agent(app.getHttpServer());
    const created = await guest
      .post('/api/v1/cart/items')
      .send({ productId: productAId, qty: 1 })
      .expect(201);
    noteSid(created);

    const patched = await guest
      .patch(`/api/v1/cart/items/${productAId}`)
      .send({ qty: 3 })
      .expect(200);
    const cart = trackCart(patched);
    expect(cart.items[0]).toMatchObject({ qty: 3, lineTotalAmount: 300_00 });
    expect(cart).toMatchObject({ totalAmount: 300_00, itemCount: 3 });

    const removed = await guest.delete(`/api/v1/cart/items/${productAId}`).expect(200);
    expect(trackCart(removed)).toMatchObject({ items: [], totalAmount: 0, itemCount: 0 });

    const again = await guest.delete(`/api/v1/cart/items/${productAId}`).expect(200);
    expect((again.body as CartBody).items).toHaveLength(0);
  });

  it('rejects quantities beyond the available stock with 409', async () => {
    const guest = request.agent(app.getHttpServer());

    // PB has stock 2: adding 3 fails, adding 2 succeeds, raising to 3 fails.
    const over = await guest
      .post('/api/v1/cart/items')
      .send({ productId: productBId, qty: 3 })
      .expect(409);
    noteSid(over);
    await guest.post('/api/v1/cart/items').send({ productId: productBId, qty: 2 }).expect(201);
    await guest
      .patch(`/api/v1/cart/items/${productBId}`)
      .send({ qty: 3 })
      .expect(409)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      });
    // PA has stock 5: setting 6 fails.
    await guest.post('/api/v1/cart/items').send({ productId: productAId, qty: 1 }).expect(201);
    await guest.patch(`/api/v1/cart/items/${productAId}`).send({ qty: 6 }).expect(409);
  });

  it('validates inputs (400) and unknown products/lines (404)', async () => {
    const guest = request.agent(app.getHttpServer());
    const missing = '33333333-3333-4333-8333-333333333333';

    await guest.post('/api/v1/cart/items').send({ productId: productAId, qty: 0 }).expect(400);
    await guest.post('/api/v1/cart/items').send({ productId: 'not-a-uuid', qty: 1 }).expect(400);
    await guest.post('/api/v1/cart/items').send({ productId: productAId }).expect(400);
    const notFound = await guest
      .post('/api/v1/cart/items')
      .send({ productId: missing, qty: 1 })
      .expect(404);
    noteSid(notFound);
    await guest.patch(`/api/v1/cart/items/${productBId}`).send({ qty: 1 }).expect(404);
    await guest.patch(`/api/v1/cart/items/not-a-uuid`).send({ qty: 1 }).expect(400);
    await guest.get('/api/v1/cart?currency=XXX').expect(400);
  });

  it('resolves the EUR override and falls back to the base price', async () => {
    const guest = request.agent(app.getHttpServer());
    const first = await guest
      .post('/api/v1/cart/items')
      .send({ productId: productAId, qty: 1 })
      .expect(201);
    noteSid(first);
    await guest.post('/api/v1/cart/items').send({ productId: productBId, qty: 1 }).expect(201);

    const eur = await guest.get('/api/v1/cart?currency=EUR').expect(200);
    const cart = trackCart(eur);
    const byId = new Map(cart.items.map((item) => [item.productId, item]));
    // PA has a EUR override; PB falls back to the USD base price.
    expect(byId.get(productAId)).toMatchObject({ unitPriceAmount: 90_00, lineTotalAmount: 90_00 });
    expect(byId.get(productBId)).toMatchObject({ unitPriceAmount: 50_00, lineTotalAmount: 50_00 });
    expect(cart).toMatchObject({ currency: 'EUR', totalAmount: 140_00, itemCount: 2 });
  });

  it('authenticated users get their own cart; a tampered sid starts a fresh guest cart', async () => {
    const email = `e2e-cart-user-${suffix}@example.com`;
    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'long-enough-password' })
      .expect(201);
    const userId = (registered.body as { user: { id: string } }).user.id;
    createdUserIds.push(userId);
    const token = (registered.body as { tokens: { accessToken: string } }).tokens.accessToken;

    const authed = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const userCart = trackCart(authed);
    expect(userCart.items).toHaveLength(0);

    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: productBId, qty: 1 })
      .expect(201);

    // The user cart holds the line even without any cookie…
    const again = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((again.body as CartBody).items).toHaveLength(1);

    // …while a tampered sid is treated as absent (fresh empty guest cart).
    const forged = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Cookie', 'sid=forged.invalid')
      .expect(200);
    trackCart(forged);
    noteSid(forged);
    expect((forged.body as CartBody).items).toHaveLength(0);
    expect((forged.headers['set-cookie'] as unknown as string[] | undefined)?.join(';')).toMatch(
      /sid=/,
    );
  });

  it('POST /cart/merge folds the guest cart into the user cart, capping at stock', async () => {
    const email = `e2e-cart-merge-${suffix}@example.com`;
    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'long-enough-password' })
      .expect(201);
    const userId = (registered.body as { user: { id: string } }).user.id;
    createdUserIds.push(userId);
    const token = (registered.body as { tokens: { accessToken: string } }).tokens.accessToken;
    const server = app.getHttpServer();

    // User cart first: PA x1 + PC x1 (PC stock is 1).
    await request(server)
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: productAId, qty: 1 })
      .expect(201);
    await request(server)
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: productCId, qty: 1 })
      .expect(201);

    // Guest cart: PA x2 + PC x1 (plain requests carrying the sid cookie).
    const g1 = await request(server)
      .post('/api/v1/cart/items')
      .send({ productId: productAId, qty: 2 })
      .expect(201);
    const guestSid = sidPair(g1);
    expect(guestSid).toMatch(/^sid=/);
    noteSid(g1);
    await request(server)
      .post('/api/v1/cart/items')
      .set('Cookie', guestSid)
      .send({ productId: productCId, qty: 1 })
      .expect(201);

    // Merge as the user, presenting the guest sid cookie.
    const merged = await request(server)
      .post('/api/v1/cart/merge')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', guestSid)
      .expect(200);
    const cart = trackCart(merged);
    const byId = new Map(cart.items.map((item) => [item.productId, item]));
    // PA: 1 + 2 = 3 (within stock 5). PC: 1 + 1 capped at stock 1.
    expect(byId.get(productAId)).toMatchObject({ qty: 3, lineTotalAmount: 300_00 });
    expect(byId.get(productCId)).toMatchObject({ qty: 1, lineTotalAmount: 30_00 });
    expect(cart).toMatchObject({ totalAmount: 330_00, itemCount: 4 });
    expect((merged.headers['set-cookie'] as unknown as string[] | undefined)?.join(';')).toMatch(
      /sid=;.*Max-Age=0/i,
    );

    // The guest cart row is gone: the same sid now resolves to an empty cart.
    const stale = await request(server).get('/api/v1/cart').set('Cookie', guestSid).expect(200);
    trackCart(stale);
    expect((stale.body as CartBody).items).toHaveLength(0);
  });

  it('POST /cart/merge without token is 401; without guest cart returns the user cart', async () => {
    const email = `e2e-cart-merge2-${suffix}@example.com`;
    const registered = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'long-enough-password' })
      .expect(201);
    const userId = (registered.body as { user: { id: string } }).user.id;
    createdUserIds.push(userId);
    const token = (registered.body as { tokens: { accessToken: string } }).tokens.accessToken;

    await request(app.getHttpServer()).post('/api/v1/cart/merge').expect(401);

    const merged = await request(app.getHttpServer())
      .post('/api/v1/cart/merge')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(trackCart(merged)).toMatchObject({ items: [], totalAmount: 0 });
  });
});
