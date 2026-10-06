import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { InsufficientStockException } from './inventory.errors.js';
import { InventoryService } from './inventory.service.js';

/**
 * Concurrency contract: N simultaneous reservations over a limited stock can
 * never oversell. Requires the Docker Compose PostgreSQL with migrations
 * applied (`docker compose up -d && npx prisma migrate dev`), same as the
 * other DB-backed suites (CI provides it; see .github/workflows/ci.yml).
 */
describe('InventoryService (concurrency, real database)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let prisma: PrismaClient;
  let service: InventoryService;
  let productId: string;
  let brandId: string;
  let categoryId: string;

  const stockOf = async (): Promise<{ stock: number; reserved: number }> => {
    const row = await prisma.inventory.findUniqueOrThrow({ where: { productId } });
    return { stock: row.stock, reserved: row.reserved };
  };

  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Start the Compose database before running DB tests.',
      );
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    service = new InventoryService(prisma as unknown as PrismaService);

    const brand = await prisma.brand.create({
      data: { name: `INV Brand ${suffix}`, slug: `inv-brand-${suffix}` },
    });
    const category = await prisma.category.create({
      data: { name: `INV Category ${suffix}`, slug: `inv-cat-${suffix}` },
    });
    const product = await prisma.product.create({
      data: {
        sku: `INV-${suffix}`,
        name: `INV Product ${suffix}`,
        slug: `inv-product-${suffix}`,
        description: 'concurrency fixture',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 10_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });
    brandId = brand.id;
    categoryId = category.id;
    productId = product.id;
    await prisma.inventory.create({ data: { productId, stock: 5, reserved: 0 } });
  }, 30_000);

  afterAll(async () => {
    // Product delete cascades to its inventory row (see ADR 0009).
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.brand.deleteMany({ where: { id: brandId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.$disconnect();
  });

  it('never oversells under concurrent reservations', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => service.reserve([{ productId, qty: 1 }])),
    );
    let succeeded = 0;
    let rejected = 0;
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled') {
        succeeded += 1;
      } else {
        rejected += 1;
        expect(attempt.reason).toBeInstanceOf(InsufficientStockException);
      }
    }

    expect(succeeded).toBe(5);
    expect(rejected).toBe(15);

    const { stock, reserved } = await stockOf();
    expect(stock).toBe(5);
    expect(reserved).toBe(5);
    await expect(service.getAvailable(productId)).resolves.toBe(0);
  }, 60_000);

  it('fails with a domain error when reserving more than available', async () => {
    // Stock is fully reserved by the previous test.
    await expect(service.reserve([{ productId, qty: 1 }])).rejects.toBeInstanceOf(
      InsufficientStockException,
    );
    await expect(service.reserve([{ productId, qty: 6 }])).rejects.toBeInstanceOf(
      InsufficientStockException,
    );
  });

  it('release frees units and commit consumes them', async () => {
    await service.release([{ productId, qty: 2 }]);
    expect(await stockOf()).toEqual({ stock: 5, reserved: 3 });
    await expect(service.getAvailable(productId)).resolves.toBe(2);

    await service.reserve([{ productId, qty: 2 }]);
    await service.commit([{ productId, qty: 5 }]);
    expect(await stockOf()).toEqual({ stock: 0, reserved: 0 });
  });

  it('DB CHECKs reject over-reservation even bypassing the service', async () => {
    await expect(
      prisma.inventory.update({
        where: { productId },
        data: { reserved: 999 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventory.update({ where: { productId }, data: { stock: -1 } }),
    ).rejects.toThrow();
  });
});
