import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Public stock surface: catalog list + detail expose `inStock` and a capped
 * `availableQuantity` (max 10), never the exact on-hand count. Fixtures use
 * run-unique `inv-e2e-` slugs and are fully removed afterwards.
 */
describe('Inventory in catalog (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  const brandSlug = `inv-e2e-brand-${suffix}`;
  const catSlug = `inv-e2e-cat-${suffix}`;
  const lowSlug = `inv-e2e-low-${suffix}`;
  const bigSlug = `inv-e2e-big-${suffix}`;
  const emptySlug = `inv-e2e-empty-${suffix}`;
  const noRowSlug = `inv-e2e-norow-${suffix}`;

  const productIds: string[] = [];
  let brandId = '';
  let categoryId = '';

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);

    const brand = await prisma.brand.create({
      data: { name: `INV E2E Brand ${suffix}`, slug: brandSlug },
    });
    const category = await prisma.category.create({
      data: { name: `INV E2E Category ${suffix}`, slug: catSlug },
    });
    brandId = brand.id;
    categoryId = category.id;

    const makeProduct = async (slug: string, stock: number | null): Promise<void> => {
      const product = await prisma.product.create({
        data: {
          sku: `INV-E2E-${slug}`,
          name: `INV E2E ${slug}`,
          slug,
          description: `INV E2E fixture ${suffix}`,
          brandId,
          categoryId,
          priceAmount: 10_00,
          currency: 'USD',
          status: 'ACTIVE',
          specs: {},
        },
      });
      productIds.push(product.id);
      if (stock !== null) {
        await prisma.inventory.create({ data: { productId: product.id, stock, reserved: 0 } });
      }
    };

    await makeProduct(lowSlug, 3);
    await makeProduct(bigSlug, 25);
    await makeProduct(emptySlug, 0);
    await makeProduct(noRowSlug, null);
  });

  afterAll(async () => {
    await prisma.inventory.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.brand.deleteMany({ where: { id: brandId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await app.close();
  });

  it('lists availability capped at 10 and never leaks exact stock', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?category=${catSlug}&sort=name_asc&limit=100`)
      .expect(200);
    const items = (res.body as { data: Record<string, unknown>[] }).data;
    const bySlug = new Map(items.map((item) => [item['slug'], item]));

    expect(bySlug.get(lowSlug)).toMatchObject({ inStock: true, availableQuantity: 3 });
    expect(bySlug.get(bigSlug)).toMatchObject({ inStock: true, availableQuantity: 10 });
    expect(bySlug.get(emptySlug)).toMatchObject({ inStock: false, availableQuantity: 0 });
    expect(bySlug.get(noRowSlug)).toMatchObject({ inStock: false, availableQuantity: 0 });

    for (const item of bySlug.values()) {
      expect(item).not.toHaveProperty('stock');
      expect(item).not.toHaveProperty('reserved');
    }
  });

  it('exposes availability in the product detail', async () => {
    const low = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${lowSlug}`)
      .expect(200);
    expect(low.body).toMatchObject({ inStock: true, availableQuantity: 3 });

    const big = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${bigSlug}`)
      .expect(200);
    expect(big.body).toMatchObject({ inStock: true, availableQuantity: 10 });

    const empty = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${emptySlug}`)
      .expect(200);
    expect(empty.body).toMatchObject({ inStock: false, availableQuantity: 0 });
  });

  it('reflects reservations without revealing exact counts', async () => {
    const low = (await prisma.product.findUniqueOrThrow({ where: { slug: lowSlug } })).id;
    await prisma.inventory.update({
      where: { productId: low },
      data: { reserved: 3 },
    });
    try {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${lowSlug}`)
        .expect(200);
      expect(res.body).toMatchObject({ inStock: false, availableQuantity: 0 });
    } finally {
      await prisma.inventory.update({ where: { productId: low }, data: { reserved: 0 } });
    }
  });
});
