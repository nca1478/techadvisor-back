/**
 * Seeds the RAG corpus shown in the admin document list
 * (`npm run seed:documents` → this file).
 *
 * Coverage (one READY document per item, visible at `/admin/documentos`):
 * - SPEC_SHEET per ACTIVE product ("ficha técnica por producto",
 *   `source = 'auto:product'`, text rendered from the product row with
 *   `buildSpecSheetText` — the same markdown the catalog hook generates).
 * - FAQ from `docs/content/faqs/<locale>/*.md` (`type: FAQ`).
 * - WARRANTY from `docs/content/warranty/<locale>/*.md` (`type: WARRANTY`).
 * - POLICY from `docs/content/policies/<locale>/*.md` (`type: POLICY`,
 *   superset of the legacy `npm run seed:policies` script).
 *
 * - Idempotent create-if-not-exists (05-control-asistencia pattern): file
 *   documents are keyed by `source = '<prefix>:<locale>:<slug>'` and spec
 *   sheets by `(productId, 'auto:product')`; when the record already exists
 *   it is left untouched (no re-embedding, no overwrite) and the run logs
 *   `SKIPPED (exists)`.
 * - Standalone `tsx` script on purpose (like `prisma/seed.ts`): it drives a
 *   direct `PrismaClient` with the configured `EmbeddingProvider` from the
 *   factory, mirroring the steps of `IngestionService.ingestDocument`
 *   (extract → hash → skip-or-chunk → batched embeddings → transactional
 *   persist) through the same pure helpers (`chunkText`, `contentHash`,
 *   `DocumentExtractorService`, `resolveEmbeddingColumnRef`). No Redis or
 *   worker needed, so the admin list is populated even before the worker
 *   ever runs. Only missing documents reach the embedding steps: existing
 *   ones return early, so re-runs cost no embedding calls.
 * - Manual uploads (`source = 'manual'`) are never touched, and seed rows
 *   deleted by an admin are NOT revived: an existing record (even
 *   soft-deleted) means "do not create".
 * - Refuses to run with `NODE_ENV=production`. The markdowns are clearly
 *   marked sample templates — the business must review them first.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { parseEnv } from '../src/config/env.schema.js';
import { createEmbeddingProvider } from '../src/modules/ai/ai-provider.factory.js';
import type { EmbeddingProvider } from '../src/modules/ai/interfaces/embedding-provider.interface.js';
import { chunkText } from '../src/modules/ingestion/chunker.js';
import { contentHash } from '../src/modules/ingestion/content-hash.js';
import { DocumentExtractorService } from '../src/modules/ingestion/document-extractor.service.js';
import { AUTO_PRODUCT_SOURCE } from '../src/modules/ingestion/ingestion.constants.js';
import { buildSpecSheetText } from '../src/modules/ingestion/product-spec-sheet.service.js';
import {
  assertEmbeddingColumnIdentifier,
  resolveEmbeddingColumnRef,
} from '../src/modules/reindex/embedding-columns.js';

const CONTENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'content');
const MARKDOWN_TYPE = 'text/markdown';

interface ContentGroup {
  /** Subdirectory of `docs/content` holding `<locale>/*.md` files. */
  dir: string;
  /** Document type stored for every file of the group. */
  type: 'POLICY' | 'FAQ' | 'WARRANTY';
  /** Prefix of the provenance key `'<prefix>:<locale>:<slug>'`. */
  prefix: string;
}

const CONTENT_GROUPS: readonly ContentGroup[] = [
  { dir: 'policies', type: 'POLICY', prefix: 'seed:policy' },
  { dir: 'faqs', type: 'FAQ', prefix: 'seed:faq' },
  { dir: 'warranty', type: 'WARRANTY', prefix: 'seed:warranty' },
];

/** Provenance key for a file document (stable across re-runs). */
export function seedDocumentSource(prefix: string, locale: string, slug: string): string {
  return `${prefix}:${locale}:${slug}`;
}

/** Display title: first `# heading` of the markdown, else the file slug. */
export function seedDocumentTitle(markdown: string, slug: string): string {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      const heading = trimmed
        .slice(2)
        .trim()
        .replace(/\s+[—-]+\s+.*$/, '');
      if (heading.length > 0) {
        return heading.slice(0, 200);
      }
    }
  }
  return slug;
}

/** Display title of the per-product spec sheet (mirrors the catalog hook). */
export function specSheetTitle(productName: string): string {
  return `Spec sheet: ${productName}`.slice(0, 200);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`seed:documents: missing required environment variable ${name}`);
  }
  return value;
}

interface PersistedChunkInput {
  content: string;
  section: number;
}

async function persistChunks(
  prisma: PrismaClient,
  embeddings: EmbeddingProvider,
  column: string,
  cast: string,
  documentId: string,
  productId: string | null,
  categoryId: string | null,
  docType: string,
  title: string,
  locale: string,
  text: string,
  hash: string,
): Promise<number> {
  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error('Document produced no chunks (no readable text blocks)');
  }
  const vectors = await embeddings.embed(chunks.map((chunk) => chunk.content));
  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding provider returned ${String(vectors.length)} vectors for ${String(chunks.length)} chunks`,
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.chunk.deleteMany({ where: { documentId } });
    const rows = chunks.map((chunk: PersistedChunkInput, index: number) => ({
      id: randomUUID(),
      documentId,
      productId,
      ord: index,
      content: chunk.content,
      locale,
      metadata: {
        productId,
        categoryId,
        docType,
        title,
        section: chunk.section,
      },
      embeddingModel: embeddings.model,
      embeddingDim: embeddings.dimensions,
    }));
    await tx.chunk.createMany({ data: rows });
    const columnRef = Prisma.raw(`"${column}"`);
    const vectorCast = Prisma.raw(cast);
    for (const [index, row] of rows.entries()) {
      const vector = vectors.at(index);
      if (vector === undefined) {
        throw new Error(`Missing embedding vector for chunk ${String(index)}`);
      }
      const literal = `[${vector.join(',')}]`;
      await tx.$executeRaw(
        Prisma.sql`UPDATE "chunks" SET ${columnRef} = ${literal}::${vectorCast} WHERE "id" = ${row.id}::uuid`,
      );
    }
  });
  await prisma.document.update({
    where: { id: documentId },
    data: { status: 'READY', contentHash: hash, error: null, deletedAt: null },
  });
  return chunks.length;
}

async function ingestFileDocument(
  prisma: PrismaClient,
  embeddings: EmbeddingProvider,
  extractor: DocumentExtractorService,
  column: string,
  cast: string,
  group: ContentGroup,
  locale: string,
  slug: string,
  markdown: string,
): Promise<'ready' | 'skipped'> {
  const source = seedDocumentSource(group.prefix, locale, slug);

  // Create-if-not-exists (05-control-asistencia pattern): when the record
  // already exists it is left untouched — no re-embedding, no overwrite.
  const alreadyExists = await prisma.document.findFirst({
    where: { source },
    select: { id: true },
  });
  if (alreadyExists) {
    return 'skipped';
  }

  const { text } = await extractor.extract(Buffer.from(markdown, 'utf8'), MARKDOWN_TYPE);
  const hash = contentHash(text);

  const title = seedDocumentTitle(markdown, slug);
  const { id: documentId } = await prisma.document.create({
    data: {
      type: group.type,
      title,
      locale,
      productId: null,
      categoryId: null,
      source,
      contentHash: 'pending',
      status: 'PENDING',
    },
    select: { id: true },
  });

  await prisma.document.update({
    where: { id: documentId },
    data: {
      type: group.type,
      title,
      locale,
      productId: null,
      categoryId: null,
      status: 'PROCESSING',
      error: null,
      deletedAt: null,
    },
  });
  try {
    await persistChunks(
      prisma,
      embeddings,
      column,
      cast,
      documentId,
      null,
      null,
      group.type,
      title,
      locale,
      text,
      hash,
    );
    return 'ready';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown ingestion failure';
    await prisma.document.update({
      where: { id: documentId },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    });
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed:documents: refusing to run with NODE_ENV=production');
  }
  const config = parseEnv();
  const defaultLocale = config.DEFAULT_LOCALE;
  const embeddings = createEmbeddingProvider(config);
  const extractor = new DocumentExtractorService();
  const { column, cast } = resolveEmbeddingColumnRef(embeddings.dimensions);
  assertEmbeddingColumnIdentifier(column);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: requireEnv('DATABASE_URL') }),
  });
  try {
    let ready = 0;
    let skipped = 0;

    for (const group of CONTENT_GROUPS) {
      const groupDir = join(CONTENT_ROOT, group.dir);
      let locales: string[];
      try {
        locales = (await readdir(groupDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
      } catch {
        console.log(`seed:documents: ${group.dir}/ → MISSING (skipped)`);
        continue;
      }
      for (const locale of locales) {
        const files = (await readdir(join(groupDir, locale)))
          .filter((file) => file.endsWith('.md'))
          .sort();
        for (const file of files) {
          const slug = basename(file, '.md');
          const markdown = await readFile(join(groupDir, locale, file), 'utf8');
          const outcome = await ingestFileDocument(
            prisma,
            embeddings,
            extractor,
            column,
            cast,
            group,
            locale,
            slug,
            markdown,
          );
          if (outcome === 'ready') {
            ready += 1;
            console.log(`seed:documents: ${group.type} ${locale}/${file} → READY`);
          } else {
            skipped += 1;
            console.log(`seed:documents: ${group.type} ${locale}/${file} → SKIPPED (exists)`);
          }
        }
      }
    }

    // SPEC_SHEET per ACTIVE product ("ficha técnica por producto"): the same
    // markdown the catalog hook (`ProductSpecSheetService`) generates, so the
    // product-QA advisor always finds evidence even when the worker never ran.
    const products = await prisma.product.findMany({
      where: { status: 'ACTIVE' },
      include: {
        brand: { select: { name: true } },
        category: { select: { name: true } },
      },
      orderBy: { sku: 'asc' },
    });
    let specReady = 0;
    let specSkipped = 0;
    for (const product of products) {
      // Create-if-not-exists: an existing spec sheet is left untouched.
      const specExists = await prisma.document.findFirst({
        where: { productId: product.id, source: AUTO_PRODUCT_SOURCE },
        select: { id: true },
      });
      if (specExists) {
        specSkipped += 1;
        continue;
      }
      const text = buildSpecSheetText({
        name: product.name,
        description: product.description,
        sku: product.sku,
        specs: product.specs,
        brand: { name: product.brand.name },
        category: { name: product.category.name },
      });
      const hash = contentHash(text);
      const title = specSheetTitle(product.name);
      const { id: documentId } = await prisma.document.create({
        data: {
          productId: product.id,
          categoryId: product.categoryId,
          type: 'SPEC_SHEET',
          title,
          locale: defaultLocale,
          source: AUTO_PRODUCT_SOURCE,
          contentHash: 'pending',
          status: 'PENDING',
        },
        select: { id: true },
      });
      await prisma.document.update({
        where: { id: documentId },
        data: {
          productId: product.id,
          categoryId: product.categoryId,
          type: 'SPEC_SHEET',
          title,
          locale: defaultLocale,
          status: 'PROCESSING',
          error: null,
          deletedAt: null,
        },
      });
      try {
        const count = await persistChunks(
          prisma,
          embeddings,
          column,
          cast,
          documentId,
          product.id,
          product.categoryId,
          'SPEC_SHEET',
          title,
          defaultLocale,
          text,
          hash,
        );
        specReady += 1;
        console.log(`seed:documents: SPEC_SHEET ${product.sku} → READY (${String(count)} chunks)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown ingestion failure';
        await prisma.document.update({
          where: { id: documentId },
          data: { status: 'FAILED', error: message.slice(0, 500) },
        });
        throw error;
      }
    }

    console.log(
      `seed:documents: ok — files ingested=${String(ready)} skipped=${String(skipped)} ` +
        `specSheets ingested=${String(specReady)} skipped=${String(specSkipped)} ` +
        `products=${String(products.length)}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isEntrypoint =
  typeof process.argv[1] === 'string' && process.argv[1].endsWith('seed-documents.ts');
if (isEntrypoint) {
  await main();
}
