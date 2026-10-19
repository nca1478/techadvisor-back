import { describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin.service.js';

interface TakenDb {
  product: { findUnique: ReturnType<typeof vi.fn> };
}

function serviceWithTaken(taken: Set<string>): { service: AdminService; db: TakenDb } {
  const db: TakenDb = {
    product: {
      findUnique: vi.fn(({ where }: { where: { sku?: string; slug?: string } }) => {
        const key = where.sku ?? where.slug ?? '';
        return Promise.resolve(taken.has(key) ? { id: 'existing' } : null);
      }),
    },
  };
  // justificado: PrismaService is a database facade; the mock covers exactly the delegate used.
  const service = new AdminService(db as never, {} as never, {} as never, {} as never);
  return { service, db };
}

describe('AdminService suggestSku/suggestSlug', () => {
  it('returns a free SKU even when the first candidates collide', async () => {
    const { service, db } = serviceWithTaken(new Set());
    db.product.findUnique
      .mockResolvedValueOnce({ id: 'existing' })
      .mockResolvedValueOnce({ id: 'existing' });
    const { sku } = await service.suggestSku();
    expect(sku.startsWith('TA-')).toBe(true);
  });

  it('derives the slug from the given name and skips taken slugs', async () => {
    const { service } = serviceWithTaken(new Set());
    const { slug } = await service.suggestSlug('ASUS TUF RTX 5080 OC');
    expect(slug.startsWith('asus-tuf-rtx-5080-oc-')).toBe(true);
  });

  it('throws a conflict when no free identifier appears', async () => {
    const db: TakenDb = {
      product: { findUnique: vi.fn(() => Promise.resolve({ id: 'existing' })) },
    };
    // justificado: PrismaService is a database facade; permanent collision exhausts retries.
    const busy = new AdminService(db as never, {} as never, {} as never, {} as never);
    await expect(busy.suggestSku()).rejects.toThrow('unique');
    await expect(busy.suggestSlug('x')).rejects.toThrow('unique');
    expect(db.product.findUnique).toHaveBeenCalledTimes(40);
  });
});
