import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Assumes the local env: BASE_CURRENCY=USD, SUPPORTED_CURRENCIES=USD,EUR,
 * DEFAULT_LOCALE=en, SUPPORTED_LOCALES=en,es (backend/.env).
 *
 * Fixtures use run-unique `e2e-` slugs, except the `laptops` category which
 * is looked up and only created when missing (it is deleted afterwards only
 * when this run created it), so the suite never mutates pre-existing rows.
 */
describe('Catalog (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  const brandAlphaSlug = `e2e-brand-alpha-${suffix}`;
  const brandBetaSlug = `e2e-brand-beta-${suffix}`;
  const catSlug = `e2e-cat-${suffix}`;
  const p1Slug = `e2e-ultrabook-pro-${suffix}`;
  const p2Slug = `e2e-budget-notebook-${suffix}`;
  const p3Slug = `e2e-gadget-${suffix}`;
  const draftSlug = `e2e-draft-item-${suffix}`;
  const archivedSlug = `e2e-archived-item-${suffix}`;

  const createdProductIds: string[] = [];
  const createdBrandIds: string[] = [];
  const createdCategoryIds: string[] = [];
  let laptopsId = '';

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);

    const alpha = await prisma.brand.create({
      data: { name: `E2E Alpha ${suffix}`, slug: brandAlphaSlug },
    });
    const beta = await prisma.brand.create({
      data: { name: `E2E Beta ${suffix}`, slug: brandBetaSlug },
    });
    createdBrandIds.push(alpha.id, beta.id);

    let laptops = await prisma.category.findUnique({ where: { slug: 'laptops' } });
    if (!laptops) {
      laptops = await prisma.category.create({ data: { name: 'Laptops', slug: 'laptops' } });
      createdCategoryIds.push(laptops.id);
    }
    laptopsId = laptops.id;

    const cat = await prisma.category.create({
      data: {
        name: `E2E Category ${suffix}`,
        slug: catSlug,
        translations: { create: [{ locale: 'es', name: `Categoría E2E ${suffix}` }] },
      },
    });
    createdCategoryIds.push(cat.id);

    // P1: full fixture (EUR override, 3 images out of order, one alt missing).
    const p1 = await prisma.product.create({
      data: {
        sku: `E2E-P1-${suffix}`,
        name: `E2E Ultrabook Pro ${suffix}`,
        slug: p1Slug,
        description: `E2E flagship ultrabook ${suffix}`,
        brandId: alpha.id,
        categoryId: laptops.id,
        priceAmount: 129_900,
        currency: 'USD',
        status: 'ACTIVE',
        specs: { cpu: 'Ultra 7 155H', ram_gb: 16, storage_gb: 512, screen_inches: 13.3 },
        prices: { create: [{ currency: 'EUR', amount: 119_900 }] },
        images: {
          create: [
            { url: 'https://cdn.example.com/e2e/p1-side.jpg', alt: 'Side view', position: 2 },
            { url: 'https://cdn.example.com/e2e/p1-front.jpg', alt: null, position: 0 },
            { url: 'https://cdn.example.com/e2e/p1-back.jpg', alt: 'Back view', position: 1 },
          ],
        },
      },
    });

    // P2: Spanish translation, no images, no EUR override.
    const p2 = await prisma.product.create({
      data: {
        sku: `E2E-P2-${suffix}`,
        name: `E2E Budget Notebook ${suffix}`,
        slug: p2Slug,
        description: `E2E budget notebook ${suffix}`,
        brandId: beta.id,
        categoryId: laptops.id,
        priceAmount: 59_900,
        currency: 'USD',
        status: 'ACTIVE',
        specs: { ram_gb: 8, storage_gb: 256 },
        translations: {
          create: [
            {
              locale: 'es',
              name: `Portátil económico E2E ${suffix}`,
              description: `Portátil económico E2E ${suffix}`,
            },
          ],
        },
      },
    });

    const p3 = await prisma.product.create({
      data: {
        sku: `E2E-P3-${suffix}`,
        name: `E2E Gadget ${suffix}`,
        slug: p3Slug,
        description: `E2E gadget ${suffix}`,
        brandId: alpha.id,
        categoryId: cat.id,
        priceAmount: 29_900,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });

    const draft = await prisma.product.create({
      data: {
        sku: `E2E-DRAFT-${suffix}`,
        name: `E2E Draft Item ${suffix}`,
        slug: draftSlug,
        description: 'draft',
        brandId: alpha.id,
        categoryId: laptops.id,
        priceAmount: 10_00,
        currency: 'USD',
        status: 'DRAFT',
        specs: {},
      },
    });
    const archived = await prisma.product.create({
      data: {
        sku: `E2E-ARCH-${suffix}`,
        name: `E2E Archived Item ${suffix}`,
        slug: archivedSlug,
        description: 'archived',
        brandId: alpha.id,
        categoryId: laptops.id,
        priceAmount: 10_00,
        currency: 'USD',
        status: 'ARCHIVED',
        specs: {},
      },
    });
    createdProductIds.push(p1.id, p2.id, p3.id, draft.id, archived.id);
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.brand.deleteMany({ where: { id: { in: createdBrandIds } } });
    await prisma.category.deleteMany({ where: { id: { in: createdCategoryIds } } });
    await app.close();
  });

  it('lists brands', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/catalog/brands').expect(200);
    const slugs = (res.body as { slug: string }[]).map((brand) => brand.slug);
    expect(slugs).toContain(brandAlphaSlug);
    expect(slugs).toContain(brandBetaSlug);
  });

  it('lists categories with specs schemas', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/catalog/categories').expect(200);
    const categories = res.body as {
      slug: string;
      specsSchema: { key: string; label: string; type: string }[];
      locale: string;
    }[];
    const laptops = categories.find((category) => category.slug === 'laptops');
    expect(laptops).toBeDefined();
    expect(laptops?.locale).toBe('en');
    expect(laptops?.specsSchema.map((field) => field.key)).toContain('ram_gb');
    expect(laptops?.specsSchema[0]).toEqual(
      expect.objectContaining({
        key: expect.any(String),
        label: expect.any(String),
        type: expect.any(String),
      }),
    );
  });

  it('returns the category detail with specsSchema and localized fallback', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/catalog/categories/laptops')
      .expect(200);
    expect(res.body).toMatchObject({ slug: 'laptops', parentSlug: null, locale: 'en' });
    expect((res.body.specsSchema as unknown[]).length).toBeGreaterThan(0);

    const es = await request(app.getHttpServer())
      .get(`/api/v1/catalog/categories/${catSlug}?locale=es`)
      .expect(200);
    expect(es.body).toMatchObject({ slug: catSlug, name: `Categoría E2E ${suffix}`, locale: 'es' });

    const fallback = await request(app.getHttpServer())
      .get(`/api/v1/catalog/categories/${catSlug}?locale=en`)
      .expect(200);
    expect(fallback.body).toMatchObject({ name: `E2E Category ${suffix}`, locale: 'en' });
  });

  it('404s on unknown category with the uniform payload', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/catalog/categories/no-such-category')
      .expect(404)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
      });
  });

  it('lists products paginated, ACTIVE only, without internal fields', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?brand=${brandAlphaSlug}`)
      .expect(200);
    const body = res.body as {
      data: Record<string, unknown>[];
      meta: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
        hasNext: boolean;
        hasPrev: boolean;
      };
    };
    expect(body.meta).toMatchObject({ page: 1, limit: 20 });
    expect(body.meta.total).toBe(2); // P1 + P3 (draft/archived excluded)
    const slugs = body.data.map((item) => item['slug']);
    expect(slugs).toContain(p1Slug);
    expect(slugs).toContain(p3Slug);
    expect(slugs).not.toContain(draftSlug);
    expect(slugs).not.toContain(archivedSlug);
    for (const item of body.data) {
      expect(item).not.toHaveProperty('status');
      expect(item).not.toHaveProperty('price_amount');
      expect(item).not.toHaveProperty('stock');
    }
  });

  it('exposes the primary image in the list (nulls when imageless)', async () => {
    const p1q = encodeURIComponent(`E2E Ultrabook Pro ${suffix}`);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?q=${p1q}`)
      .expect(200);
    const items = (res.body as { data: { imageUrl: string | null; imageAlt: string | null }[] })
      .data;
    expect(items).toHaveLength(1);
    expect(items[0].imageUrl).toBe('https://cdn.example.com/e2e/p1-front.jpg');
    expect(items[0].imageAlt).toBeNull();

    const p2q = encodeURIComponent(`E2E Budget Notebook ${suffix}`);
    const bare = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?q=${p2q}`)
      .expect(200);
    const bareItems = (
      bare.body as { data: { imageUrl: string | null; imageAlt: string | null }[] }
    ).data;
    expect(bareItems).toHaveLength(1);
    expect(bareItems[0].imageUrl).toBeNull();
    expect(bareItems[0].imageAlt).toBeNull();
  });

  it('filters by category, price range, text and sort combined', async () => {
    const res = await request(app.getHttpServer())
      .get(
        `/api/v1/catalog/products?category=laptops&minPrice=50000&maxPrice=70000&sort=price_asc&q=${suffix}`,
      )
      .expect(200);
    const body = res.body as { data: { slug: string }[]; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]?.slug).toBe(p2Slug);
  });

  it('paginates with coherent metadata', async () => {
    const page1 = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?brand=${brandAlphaSlug}&limit=1&page=1&sort=name_asc`)
      .expect(200);
    const page2 = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?brand=${brandAlphaSlug}&limit=1&page=2&sort=name_asc`)
      .expect(200);
    expect((page1.body as { meta: object }).meta).toMatchObject({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
      hasNext: true,
      hasPrev: false,
    });
    expect((page2.body as { meta: object }).meta).toMatchObject({
      page: 2,
      hasNext: false,
      hasPrev: true,
    });
    expect((page1.body as { data: { slug: string }[] }).data[0]?.slug).not.toBe(
      (page2.body as { data: { slug: string }[] }).data[0]?.slug,
    );
  });

  it('resolves the EUR override, falls back to base, and rejects unknown currencies', async () => {
    const eur = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${p1Slug}?currency=EUR`)
      .expect(200);
    expect(eur.body).toMatchObject({ priceAmount: 119_900, currency: 'EUR' });

    const fallback = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${p2Slug}?currency=EUR`)
      .expect(200);
    expect(fallback.body).toMatchObject({ priceAmount: 59_900, currency: 'USD' });

    // EUR range: only P1 has a EUR price inside [100000, 130000].
    const filtered = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products?currency=EUR&minPrice=100000&maxPrice=130000&q=${suffix}`)
      .expect(200);
    expect((filtered.body as { data: { slug: string }[] }).data.map((item) => item.slug)).toEqual([
      p1Slug,
    ]);

    await request(app.getHttpServer()).get('/api/v1/catalog/products?currency=XXX').expect(400);
  });

  it('localizes product texts with fallback to the default locale', async () => {
    const es = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${p2Slug}?locale=es`)
      .expect(200);
    expect(es.body).toMatchObject({ name: `Portátil económico E2E ${suffix}`, locale: 'es' });

    const fallback = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${p1Slug}?locale=es`)
      .expect(200);
    expect(fallback.body).toMatchObject({ name: `E2E Ultrabook Pro ${suffix}`, locale: 'es' });
  });

  it('returns detail with images ordered by position', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/catalog/products/${p1Slug}`)
      .expect(200);
    expect(res.body).toMatchObject({
      slug: p1Slug,
      sku: `E2E-P1-${suffix}`,
      priceAmount: 129_900,
      currency: 'USD',
      locale: 'en',
    });
    expect(
      (res.body as { images: { position: number }[] }).images.map((image) => image.position),
    ).toEqual([0, 1, 2]);
    expect(res.body).toHaveProperty('brand');
    expect((res.body as { category: { id: string; slug: string } }).category).toMatchObject({
      id: laptopsId,
      slug: 'laptops',
    });
    expect((res.body as { specs: object }).specs).toMatchObject({ ram_gb: 16 });
  });

  it('404s on DRAFT, ARCHIVED and unknown slugs alike', async () => {
    for (const slug of [draftSlug, archivedSlug, 'no-such-product']) {
      await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${slug}`)
        .expect(404)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
        });
    }
  });

  it('validates query params with 400s', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/catalog/products?minPrice=500&maxPrice=100')
      .expect(400);
    await request(app.getHttpServer()).get('/api/v1/catalog/products?limit=500').expect(400);
    await request(app.getHttpServer()).get('/api/v1/catalog/products?page=0').expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/catalog/products?locale=not_a_locale')
      .expect(400);
  });
});
