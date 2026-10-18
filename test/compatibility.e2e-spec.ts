import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Deterministic compatibility endpoint (e2e, see ADR 0034).
 *
 * Boots the full app (no provider mocks needed — the engine never calls an
 * LLM) with fixtures mirroring real seed rows: an AM5 CPU, an AM5/DDR5 board
 * with connector data, a DDR5 kit, a 550W supply, plus mismatch fixtures (an
 * LGA1700/DDR4 board, a 125W CPU, a 263W GPU) and a raw-seed-shape board
 * without connector data for the missing-data path.
 */
describe('Compatibility check endpoint (e2e)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let app: INestApplication;
  let prisma: PrismaService;

  let brandId = '';
  const createdCategoryIds: string[] = [];
  const createdProductIds: string[] = [];

  let cpuAm5Id = '';
  let boardAm5Id = '';
  let ramDdr5Id = '';
  let psu550Id = '';
  let boardLgaId = '';
  let cpu125Id = '';
  let gpu263Id = '';
  let boardRawId = '';
  let nvmeId = '';

  async function ensureCategory(slug: string, name: string): Promise<string> {
    const existing = await prisma.category.findUnique({ where: { slug } });
    if (existing) {
      return existing.id;
    }
    const created = await prisma.category.create({ data: { name, slug } });
    createdCategoryIds.push(created.id);
    return created.id;
  }

  async function createProduct(
    skuSuffix: string,
    name: string,
    brandIdValue: string,
    categoryId: string,
    specs: Prisma.InputJsonValue,
  ): Promise<string> {
    const row = await prisma.product.create({
      data: {
        sku: `E2E-COMPAT-${skuSuffix}-${suffix}`,
        name: `${name} ${suffix}`,
        slug: `e2e-compat-${skuSuffix.toLowerCase()}-${suffix}`,
        description: `E2E compatibility fixture ${skuSuffix} ${suffix}`,
        brandId: brandIdValue,
        categoryId,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs,
      },
    });
    createdProductIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);

    const brand = await prisma.brand.create({
      data: { name: `E2E Compat Brand ${suffix}`, slug: `e2e-compat-brand-${suffix}` },
    });
    brandId = brand.id;

    const cpus = await ensureCategory('cpus', 'Processors');
    const boards = await ensureCategory('motherboards', 'Motherboards');
    const ram = await ensureCategory('ram', 'Memory');
    const psus = await ensureCategory('psus', 'Power supplies');
    const gpus = await ensureCategory('gpus', 'Graphics cards');
    const storage = await ensureCategory('storage', 'Storage');

    cpuAm5Id = await createProduct('CPU-AM5', 'E2E Ryzen 5', brandId, cpus, {
      socket: 'AM5',
      tdp_w: 65,
    });
    boardAm5Id = await createProduct('BOARD-AM5', 'E2E B650', brandId, boards, {
      socket: 'AM5',
      ram_type: 'DDR5',
      ram_slots: 4,
      max_ram_gb: 128,
      max_ram_speed_mt_s: 6400,
      m2_slots: 3,
      sata_ports: 6,
    });
    ramDdr5Id = await createProduct('RAM-DDR5', 'E2E DDR5 16GB', brandId, ram, {
      ram_type: 'DDR5',
      ram_gb: 16,
      speed_mt_s: 5600,
      modules: 2,
    });
    psu550Id = await createProduct('PSU-550', 'E2E 550W', brandId, psus, { wattage_w: 550 });
    boardLgaId = await createProduct('BOARD-LGA', 'E2E B660M', brandId, boards, {
      socket: 'LGA1700',
      ram_type: 'DDR4',
      ram_slots: 4,
      max_ram_gb: 128,
      max_ram_speed_mt_s: 4800,
      m2_slots: 2,
      sata_ports: 4,
    });
    cpu125Id = await createProduct('CPU-125', 'E2E i7', brandId, cpus, {
      socket: 'LGA1700',
      tdp_w: 125,
    });
    gpu263Id = await createProduct('GPU-263', 'E2E RX 7800', brandId, gpus, { tdp_w: 263 });
    // Raw seed shape: no max_ram_speed_mt_s / m2_slots / sata_ports.
    boardRawId = await createProduct('BOARD-RAW', 'E2E Raw Board', brandId, boards, {
      socket: 'AM5',
      ram_type: 'DDR5',
      ram_slots: 4,
      max_ram_gb: 128,
    });
    nvmeId = await createProduct('NVME', 'E2E NVMe 1TB', brandId, storage, {
      storage_type: 'NVME',
      form_factor: 'M.2 2280',
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    await prisma.brand.deleteMany({ where: { id: brandId } });
    await prisma.category.deleteMany({ where: { id: { in: createdCategoryIds } } });
    await app.close();
  });

  it('marks a coherent build compatible with no issues', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ productIds: [cpuAm5Id, boardAm5Id, ramDdr5Id, psu550Id] })
      .expect(200);

    const body = res.body as { compatible: boolean; issues: unknown[] };
    expect(body.compatible).toBe(true);
    expect(body.issues).toEqual([]);
  });

  it('detects a socket mismatch (AM5 CPU + LGA1700 board)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ productIds: [cpuAm5Id, boardLgaId] })
      .expect(200);

    const body = res.body as {
      compatible: boolean;
      issues: { rule: string; severity: string; productIds: string[]; messageKey: string }[];
    };
    expect(body.compatible).toBe(false);
    const socket = body.issues.filter((issue) => issue.rule === 'cpu-socket');
    expect(socket).toHaveLength(1);
    expect(socket[0]?.severity).toBe('error');
    expect(socket[0]?.messageKey).toBe('cpu-socket.mismatch');
  });

  it('detects an insufficient PSU (125W CPU + 263W GPU on 550W)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ productIds: [cpu125Id, boardLgaId, gpu263Id, psu550Id] })
      .expect(200);

    const body = res.body as {
      compatible: boolean;
      issues: { rule: string; severity: string }[];
    };
    expect(body.compatible).toBe(false);
    const psu = body.issues.filter((issue) => issue.rule === 'psu-wattage');
    expect(psu).toHaveLength(1);
    expect(psu[0]?.severity).toBe('error');
  });

  it('warns (never claims compatible) when board connector data is missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ productIds: [boardRawId, ramDdr5Id, nvmeId] })
      .expect(200);

    const body = res.body as {
      compatible: boolean;
      issues: { rule: string; severity: string }[];
    };
    expect(body.compatible).toBe(false);
    expect(body.issues.length).toBeGreaterThan(0);
    for (const issue of body.issues) {
      expect(issue.severity).toBe('warning');
    }
  });

  it('renders messages in Spanish when locale es is requested', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ productIds: [cpuAm5Id, boardLgaId], locale: 'es' })
      .expect(200);

    const body = res.body as { issues: { message: string; messageKey: string }[] };
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0]?.messageKey).toBe('cpu-socket.mismatch');
    expect(body.issues[0]?.message).toContain('No encajan');
  });

  it('validates the request body', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ productIds: [] })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ productIds: [cpuAm5Id, cpuAm5Id] })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ productIds: ['not-a-uuid'] })
      .expect(400);
    await request(app.getHttpServer()).post('/api/v1/compatibility/check').send({}).expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({
        items: [
          { productId: cpuAm5Id, qty: 1 },
          { productId: cpuAm5Id, qty: 2 },
        ],
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ items: [{ productId: cpuAm5Id, qty: 0 }] })
      .expect(400);
  });

  it('counts cart quantities: 1x NVMe on a 3-slot board passes, 4x fails', async () => {
    const ok = await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({
        items: [
          { productId: boardAm5Id, qty: 1 },
          { productId: nvmeId, qty: 1 },
        ],
      })
      .expect(200);
    expect((ok.body as { compatible: boolean }).compatible).toBe(true);

    const res = await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({
        items: [
          { productId: boardAm5Id, qty: 1 },
          { productId: nvmeId, qty: 4 },
        ],
      })
      .expect(200);
    const body = res.body as {
      compatible: boolean;
      issues: { rule: string; severity: string; productIds: string[] }[];
    };
    expect(body.compatible).toBe(false);
    const storage = body.issues.filter((issue) => issue.rule === 'storage-interface');
    expect(storage).toHaveLength(1);
    expect(storage[0]?.severity).toBe('error');
    // Expanded qty dedupes ids for stable display.
    expect(storage[0]?.productIds).toEqual(expect.arrayContaining([nvmeId, boardAm5Id]));
    expect(new Set(storage[0]?.productIds ?? []).size).toBe(storage[0]?.productIds.length);
  });

  it('counts duplicated boards by qty (2x same board is a single-board error)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ items: [{ productId: boardAm5Id, qty: 2 }] })
      .expect(200);
    const body = res.body as { compatible: boolean; issues: { rule: string }[] };
    expect(body.compatible).toBe(false);
    expect(body.issues.some((issue) => issue.rule === 'build-single-board')).toBe(true);
  });

  it('returns 404 for unknown product ids', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/compatibility/check')
      .send({ productIds: ['00000000-0000-4000-8000-000000000000'] })
      .expect(404);
  });
});
