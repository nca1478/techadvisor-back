import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { IngestionService } from './ingestion.service.js';
import { ProductSpecSheetService, buildSpecSheetText } from './product-spec-sheet.service.js';

/** Unit tests for the SPEC_SHEET builder and sync logic (DB is stubbed). */
describe('buildSpecSheetText', () => {
  const product = {
    name: 'Laptop X1',
    description: 'Light laptop for engineering students.',
    sku: 'LP-X1',
    specs: { ram_gb: 16, socket: 'AM5', tags: ['a', 'b'] },
    brand: { name: 'TechBrand' },
    category: { name: 'Laptops' },
  };

  it('renders name, description, details and a sorted specs table', () => {
    const text = buildSpecSheetText(product);
    expect(text).toContain('# Laptop X1');
    expect(text).toContain('Light laptop for engineering students.');
    expect(text).toContain('- Brand: TechBrand');
    expect(text).toContain('- SKU: LP-X1');
    expect(text).toContain('| Spec | Value |');
    // Sorted keys: ram_gb < socket < tags.
    expect(text.indexOf('| ram_gb |')).toBeLessThan(text.indexOf('| socket |'));
    expect(text.indexOf('| socket |')).toBeLessThan(text.indexOf('| tags |'));
    expect(text).toContain('| ram_gb | 16 |');
  });

  it('omits the table when there are no specs', () => {
    const text = buildSpecSheetText({ ...product, specs: {} });
    expect(text).not.toContain('| Spec | Value |');
  });

  it('is deterministic regardless of specs key order', () => {
    const a = buildSpecSheetText({ ...product, specs: { b: 1, a: 2 } });
    const b = buildSpecSheetText({ ...product, specs: { a: 2, b: 1 } });
    expect(a).toBe(b);
  });
});

describe('ProductSpecSheetService.syncProduct', () => {
  const config = { DEFAULT_LOCALE: 'en' } as AppConfig;

  function setup(prismaOverrides: Record<string, unknown>) {
    const prisma = prismaOverrides as unknown as PrismaService;
    const enqueueDocument = vi.fn().mockResolvedValue({ enqueued: true });
    const ingestion = { enqueueDocument } as unknown as IngestionService;
    const service = new ProductSpecSheetService(prisma, ingestion, config);
    return { service, enqueueDocument };
  }

  const activeProduct = {
    id: 'product-1',
    status: 'ACTIVE',
    name: 'Laptop X1',
    description: 'Desc.',
    sku: 'LP-X1',
    specs: {},
    categoryId: 'cat-1',
    brand: { name: 'B' },
    category: { name: 'C' },
  };

  it('creates the auto document and enqueues it for ACTIVE products', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'doc-1' });
    const { service, enqueueDocument } = setup({
      product: { findUnique: vi.fn().mockResolvedValue(activeProduct) },
      document: { findFirst: vi.fn().mockResolvedValue(null), create, update: vi.fn() },
    });
    await service.syncProduct('product-1');
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      productId: 'product-1',
      type: 'SPEC_SHEET',
      source: 'auto:product',
      status: 'PENDING',
    });
    expect(enqueueDocument).toHaveBeenCalledOnce();
    const [docId, raw, contentType] = enqueueDocument.mock.calls[0] ?? [];
    expect(docId).toBe('doc-1');
    expect(contentType).toBe('text/markdown');
    expect(String(raw)).toContain('# Laptop X1');
  });

  it('updates the existing auto document instead of duplicating it', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'doc-1' });
    const { service, enqueueDocument } = setup({
      product: { findUnique: vi.fn().mockResolvedValue(activeProduct) },
      document: {
        findFirst: vi.fn().mockResolvedValue({ id: 'doc-1' }),
        create: vi.fn(),
        update,
      },
    });
    await service.syncProduct('product-1');
    expect(update).toHaveBeenCalledOnce();
    expect(enqueueDocument).toHaveBeenCalledWith('doc-1', expect.any(Buffer), 'text/markdown');
  });

  it('removes the auto document for non-ACTIVE products', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const { service, enqueueDocument } = setup({
      product: { findUnique: vi.fn().mockResolvedValue({ ...activeProduct, status: 'ARCHIVED' }) },
      document: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany },
    });
    await service.syncProduct('product-1');
    expect(deleteMany).toHaveBeenCalledWith({
      where: { productId: 'product-1', source: 'auto:product' },
    });
    expect(enqueueDocument).not.toHaveBeenCalled();
  });

  it('never throws when the database or queue is down', async () => {
    const { service } = setup({
      product: {
        findUnique: vi.fn().mockRejectedValue(new Error('connection refused')),
      },
      document: {},
    });
    await expect(service.syncProduct('product-1')).resolves.toBeUndefined();
  });
});
