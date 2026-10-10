import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { parseEnv } from '../src/config/env.schema.js';
import { EMBEDDING_PROVIDER } from '../src/modules/ai/interfaces/embedding-provider.interface.js';
import { FakeEmbeddingAdapter } from '../src/modules/ai/adapters/fake-embedding.adapter.js';
import { INGESTION_QUEUE } from '../src/modules/ingestion/ingestion.constants.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

interface DocumentBody {
  id: string;
  type: string;
  title: string;
  locale: string;
  productId: string | null;
  categoryId: string | null;
  sourceUrl: string | null;
  source: string;
  status: string;
  error: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  chunkCount: number;
}

/**
 * Builds a minimal single-page PDF with valid xref offsets so `pdf-parse`
 * extracts the given lines. ASCII-only content (WinAnsi-safe); the e2e
 * asserts the full upload → READY → chunks path for PDFs.
 */
function buildTestPdf(lines: string[]): Buffer {
  const escape = (line: string): string =>
    line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(Buffer.byteLength(content, 'utf8'))} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefAt)}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

function longMarkdown(marker: string, paragraphs = 12): string {
  const parts = [`# Guide ${marker}`, ''];
  for (let i = 0; i < paragraphs; i += 1) {
    parts.push(
      `## Section ${String(i + 1)}`,
      '',
      `Paragraph ${String(i + 1)} about ports, power draw, firmware updates and compatibility notes for ${marker}. `.repeat(
        6,
      ),
      '',
    );
  }
  parts.push('| Spec | Value |', '| --- | --- |', '| ram_gb | 16 |', '| socket | AM5 |', '');
  return parts.join('\n');
}

/**
 * Admin corpus documents (e2e, see ADR 0020).
 *
 * Overrides: the embedding provider with the offline fake adapter and the
 * ingestion queue with `null`, so documents ingest inline and reach READY
 * deterministically without Redis or a worker. Uploads land in a tmpdir
 * (`DOCUMENTS_DIR` override) removed afterwards; DB rows are removed too.
 */
describe('Admin documents (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  let adminToken = '';
  let customerToken = '';
  const createdUserIds: string[] = [];
  const createdDocumentIds: string[] = [];
  let documentsDir = '';
  let brandId = '';
  let categoryId = '';
  let productId = '';
  let urlServer: Server | null = null;
  let urlBase = '';

  const authHeader = (token: string): { Authorization: string } => ({
    Authorization: `Bearer ${token}`,
  });

  beforeAll(async () => {
    documentsDir = await mkdtemp(join(tmpdir(), 'e2e-docs-'));
    const config = { ...parseEnv(), DOCUMENTS_DIR: documentsDir };
    const ctx = await createTestApp([
      { token: APP_CONFIG, useValue: config },
      { token: EMBEDDING_PROVIDER, useValue: new FakeEmbeddingAdapter({ dimensions: 1536 }) },
      { token: INGESTION_QUEUE, useValue: null },
    ]);
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const passwords = ctx.module.get(PasswordService);

    for (const [email, role] of [
      [`e2e-doc-admin-${suffix}@example.com`, 'ADMIN'],
      [`e2e-doc-cust-${suffix}@example.com`, 'CUSTOMER'],
    ] as const) {
      const user = await prisma.user.create({
        data: { email, passwordHash: await passwords.hash('long-enough-password'), role },
        select: { id: true },
      });
      createdUserIds.push(user.id);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'long-enough-password' })
        .expect(200);
      const token = (login.body as { tokens: { accessToken: string } }).tokens.accessToken;
      if (role === 'ADMIN') {
        adminToken = token;
      } else {
        customerToken = token;
      }
    }

    const brand = await request(app.getHttpServer())
      .post('/api/v1/admin/brands')
      .set(authHeader(adminToken))
      .send({ name: `E2E Doc Brand ${suffix}`, slug: `e2e-doc-brand-${suffix}` })
      .expect(201);
    brandId = (brand.body as { id: string }).id;
    const category = await request(app.getHttpServer())
      .post('/api/v1/admin/categories')
      .set(authHeader(adminToken))
      .send({ name: `E2E Doc Category ${suffix}`, slug: `e2e-doc-cat-${suffix}` })
      .expect(201);
    categoryId = (category.body as { id: string }).id;
    const product = await request(app.getHttpServer())
      .post('/api/v1/admin/products')
      .set(authHeader(adminToken))
      .send({
        sku: `E2E-DOC-${suffix}`,
        name: `E2E Doc Product ${suffix}`,
        slug: `e2e-doc-product-${suffix}`,
        description: 'E2E document fixture product',
        brandId,
        categoryId,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
        prices: [],
        translations: [],
        images: [],
        initialStock: 2,
      })
      .expect(201);
    productId = (product.body as { id: string }).id;

    const served = longMarkdown(`url-doc-${suffix}`, 12);
    const server = createServer((req, res) => {
      if (req.url === '/manual.md') {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        res.end(served);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    urlServer = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    urlBase =
      typeof address === 'object' && address !== null
        ? `http://127.0.0.1:${String(address.port)}`
        : '';
  });

  afterAll(async () => {
    if (createdDocumentIds.length > 0) {
      await prisma.chunk.deleteMany({ where: { documentId: { in: createdDocumentIds } } });
      await prisma.document.deleteMany({ where: { id: { in: createdDocumentIds } } });
    }
    await prisma.document.deleteMany({ where: { productId, source: 'auto:product' } });
    if (productId !== '') {
      await prisma.product.deleteMany({ where: { id: productId } });
    }
    if (brandId !== '') {
      await prisma.brand.deleteMany({ where: { id: brandId } });
    }
    if (categoryId !== '') {
      await prisma.category.deleteMany({ where: { id: categoryId } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    if (urlServer !== null) {
      await new Promise<void>((resolve) => {
        urlServer?.close(() => {
          resolve();
        });
      });
    }
    if (documentsDir !== '') {
      await rm(documentsDir, { recursive: true, force: true });
    }
    await app.close();
  });

  it('rejects anonymous (401) and non-admin (403) access', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/documents').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/admin/documents')
      .set(authHeader(customerToken))
      .expect(403);
  });

  it('rejects a disallowed file type with a clear error', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/documents/upload')
      .set(authHeader(adminToken))
      .attach('file', Buffer.from('MZ fake executable', 'utf8'), {
        filename: 'setup.exe',
        contentType: 'application/x-msdownload',
      })
      .field('type', 'MANUAL')
      .field('locale', 'en')
      .expect(400);
    expect((res.body as { message: string }).message).toMatch(/Allowed types/);
  });

  it('rejects an upload without a file', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/documents/upload')
      .set(authHeader(adminToken))
      .field('type', 'MANUAL')
      .field('locale', 'en')
      .expect(400);
  });

  it('uploads a PDF to READY with queryable chunks and no path leaks', async () => {
    const lines = ['Laptop X1 setup guide'];
    for (let i = 0; i < 40; i += 1) {
      lines.push(
        `Line ${String(i + 1)} explains ports, power draw, firmware updates and compatibility notes for the Laptop X1 unit under test.`,
      );
    }
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/documents/upload')
      .set(authHeader(adminToken))
      .attach('file', buildTestPdf(lines), {
        filename: 'x1-manual.pdf',
        contentType: 'application/pdf',
      })
      .field('title', `X1 manual ${suffix}`)
      .field('type', 'MANUAL')
      .field('locale', 'en')
      .field('productId', productId)
      .expect(201);
    const body = res.body as DocumentBody;
    createdDocumentIds.push(body.id);
    expect(body.status).toBe('READY');
    expect(body.error).toBeNull();
    expect(body.chunkCount).toBeGreaterThan(0);
    expect(body.productId).toBe(productId);
    expect(body.mimeType).toBe('application/pdf');
    // No filesystem path ever leaves the server (ADR 0020).
    expect('storageKey' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('.bin');

    const chunk = await prisma.chunk.findFirst({
      where: { documentId: body.id },
      select: { content: true },
    });
    expect(chunk?.content).toContain('Laptop X1');
  });

  it('lists documents with status and shows detail with chunk count', async () => {
    const id = createdDocumentIds.at(0) ?? '';
    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/documents?status=READY')
      .set(authHeader(adminToken))
      .expect(200);
    const ids = ((list.body as { data?: DocumentBody[] }).data ?? []).map((row) => row.id);
    expect(ids).toContain(id);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/documents/${id}`)
      .set(authHeader(adminToken))
      .expect(200);
    expect((detail.body as DocumentBody).chunkCount).toBeGreaterThan(0);
    expect((detail.body as DocumentBody).error).toBeNull();
  });

  it('lists documents filtered by type', async () => {
    const uploaded = await request(app.getHttpServer())
      .post('/api/v1/admin/documents/upload')
      .set(authHeader(adminToken))
      .attach('file', Buffer.from(longMarkdown(`typefilter-${suffix}`, 12), 'utf8'), {
        filename: 'policy.md',
        contentType: 'text/markdown',
      })
      .field('title', `Type filter policy ${suffix}`)
      .field('type', 'POLICY')
      .field('locale', 'en')
      .expect(201);
    const policyId = (uploaded.body as DocumentBody).id;
    createdDocumentIds.push(policyId);

    const filtered = await request(app.getHttpServer())
      .get('/api/v1/admin/documents?type=POLICY')
      .set(authHeader(adminToken))
      .expect(200);
    const policyIds = ((filtered.body as { data?: DocumentBody[] }).data ?? []).map(
      (row) => row.id,
    );
    expect(policyIds).toContain(policyId);

    const other = await request(app.getHttpServer())
      .get('/api/v1/admin/documents?type=FAQ')
      .set(authHeader(adminToken))
      .expect(200);
    const otherIds = ((other.body as { data?: DocumentBody[] }).data ?? []).map((row) => row.id);
    expect(otherIds).not.toContain(policyId);

    await request(app.getHttpServer())
      .get('/api/v1/admin/documents?type=BOGUS')
      .set(authHeader(adminToken))
      .expect(400);
  });

  it('re-ingests an unchanged document idempotently (same chunk count)', async () => {
    const id = createdDocumentIds.at(0) ?? '';
    const before = await prisma.chunk.count({ where: { documentId: id } });
    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/documents/${id}/reingest`)
      .set(authHeader(adminToken))
      .expect(200);
    const body = res.body as DocumentBody;
    expect(body.status).toBe('READY');
    expect(body.chunkCount).toBe(before);
    expect(await prisma.chunk.count({ where: { documentId: id } })).toBe(before);
  });

  it('registers a document by URL and ingests it', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/documents')
      .set(authHeader(adminToken))
      .send({
        title: `URL manual ${suffix}`,
        type: 'MANUAL',
        locale: 'en',
        categoryId,
        sourceUrl: `${urlBase}/manual.md`,
      })
      .expect(201);
    const body = res.body as DocumentBody;
    createdDocumentIds.push(body.id);
    expect(body.status).toBe('READY');
    expect(body.chunkCount).toBeGreaterThan(0);
    expect(body.sourceUrl).toBe(`${urlBase}/manual.md`);
    expect(body.categoryId).toBe(categoryId);
  });

  it('rejects unknown product associations with 404', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/documents/upload')
      .set(authHeader(adminToken))
      .attach('file', Buffer.from(longMarkdown(`ghost-${suffix}`, 12), 'utf8'), {
        filename: 'ghost.md',
        contentType: 'text/markdown',
      })
      .field('type', 'MANUAL')
      .field('locale', 'en')
      .field('productId', '00000000-0000-0000-0000-000000000000')
      .expect(404);
  });

  it('soft-deletes a document: 404 on detail, excluded from list, chunks gone', async () => {
    const id = createdDocumentIds.at(0) ?? '';
    await request(app.getHttpServer())
      .delete(`/api/v1/admin/documents/${id}`)
      .set(authHeader(adminToken))
      .expect(204);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/documents/${id}`)
      .set(authHeader(adminToken))
      .expect(404);
    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/documents')
      .set(authHeader(adminToken))
      .expect(200);
    const ids = ((list.body as { data?: DocumentBody[] }).data ?? []).map((row) => row.id);
    expect(ids).not.toContain(id);
    expect(await prisma.chunk.count({ where: { documentId: id } })).toBe(0);
    const row = await prisma.document.findUnique({ where: { id } });
    expect(row?.deletedAt).not.toBeNull();
  });
});
