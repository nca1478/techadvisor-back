import type { PrismaService } from '../../prisma/prisma.service.js';
import { InsufficientStockException, InvalidQuantityException } from './inventory.errors.js';
import { InventoryService, toAvailability } from './inventory.service.js';

const PRODUCT_A = '11111111-1111-4111-8111-111111111111';
const PRODUCT_B = '22222222-2222-4222-8222-222222222222';

function createHarness() {
  const tx = { $executeRaw: vi.fn(() => Promise.resolve(1)) };
  const prisma = {
    inventory: {
      findUnique: vi.fn(),
      findMany: vi.fn(() => Promise.resolve([])),
    },
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
  const service = new InventoryService(prisma as unknown as PrismaService);
  return { service, prisma, tx };
}

describe('toAvailability', () => {
  it('maps zero to out of stock', () => {
    expect(toAvailability(0)).toEqual({ inStock: false, availableQuantity: 0 });
  });

  it('maps positive counts directly while under the cap', () => {
    expect(toAvailability(1)).toEqual({ inStock: true, availableQuantity: 1 });
    expect(toAvailability(10)).toEqual({ inStock: true, availableQuantity: 10 });
  });

  it('caps the visible quantity at 10 to avoid leaking exact stock', () => {
    expect(toAvailability(11)).toEqual({ inStock: true, availableQuantity: 10 });
    expect(toAvailability(999)).toEqual({ inStock: true, availableQuantity: 10 });
  });

  it('never surfaces negatives', () => {
    expect(toAvailability(-3)).toEqual({ inStock: false, availableQuantity: 0 });
  });
});

describe('InventoryService.getAvailable', () => {
  it('returns stock minus reserved', async () => {
    const { service, prisma } = createHarness();
    prisma.inventory.findUnique.mockResolvedValue({ stock: 8, reserved: 3 });
    await expect(service.getAvailable(PRODUCT_A)).resolves.toBe(5);
  });

  it('returns 0 when the product has no inventory row', async () => {
    const { service, prisma } = createHarness();
    prisma.inventory.findUnique.mockResolvedValue(null);
    await expect(service.getAvailable(PRODUCT_A)).resolves.toBe(0);
  });
});

describe('InventoryService.reserve', () => {
  it('reserves through one conditional UPDATE per product', async () => {
    const { service, tx } = createHarness();
    await service.reserve([
      { productId: PRODUCT_A, qty: 2 },
      { productId: PRODUCT_B, qty: 1 },
    ]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('aggregates duplicate lines for the same product', async () => {
    const { service, tx } = createHarness();
    await service.reserve([
      { productId: PRODUCT_A, qty: 1 },
      { productId: PRODUCT_A, qty: 2 },
    ]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('fails with a domain error when nothing was available', async () => {
    const { service, tx } = createHarness();
    tx.$executeRaw.mockResolvedValue(0);
    await expect(service.reserve([{ productId: PRODUCT_A, qty: 99 }])).rejects.toBeInstanceOf(
      InsufficientStockException,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects qty=%s without touching the database', async (qty) => {
    const { service, prisma, tx } = createHarness();
    await expect(service.reserve([{ productId: PRODUCT_A, qty }])).rejects.toBeInstanceOf(
      InvalidQuantityException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('rejects missing productIds', async () => {
    const { service } = createHarness();
    await expect(service.reserve([{ productId: '', qty: 1 }])).rejects.toBeInstanceOf(
      InvalidQuantityException,
    );
  });
});

describe('InventoryService.release/commit', () => {
  it('release is idempotent and never throws on missing rows', async () => {
    const { service, tx } = createHarness();
    tx.$executeRaw.mockResolvedValue(0);
    await expect(service.release([{ productId: PRODUCT_A, qty: 3 }])).resolves.toBeUndefined();
  });

  it('commit fails when the units were never reserved', async () => {
    const { service, tx } = createHarness();
    tx.$executeRaw.mockResolvedValue(0);
    await expect(service.commit([{ productId: PRODUCT_A, qty: 1 }])).rejects.toBeInstanceOf(
      InsufficientStockException,
    );
  });

  it('commit succeeds when the reservation exists', async () => {
    const { service, tx } = createHarness();
    await expect(service.commit([{ productId: PRODUCT_A, qty: 1 }])).resolves.toBeUndefined();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
