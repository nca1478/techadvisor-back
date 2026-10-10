/**
 * Ingests the sample post-sale policies (`docs/content/policies/<locale>/`)
 * as `type: POLICY` documents (`npm run seed:policies` → this file).
 *
 * - Idempotent: documents are keyed by `source = 'seed:policy:<locale>:<slug>'`
 *   and re-runs skip when the content hash is unchanged, so they converge
 *   without duplicating chunks.
 * - Standalone `tsx` script on purpose (like `prisma/seed.ts`): it drives a
 *   direct `PrismaClient` with the configured `EmbeddingProvider` from the
 *   factory, mirroring the steps of `IngestionService.ingestDocument`
 *   (extract → hash → skip-or-chunk → batched embeddings → transactional
 *   persist) through the same pure helpers (`chunkText`, `contentHash`,
 *   `DocumentExtractorService`, `resolveEmbeddingColumnRef`). No Redis or
 *   worker needed.
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
import { chunkText } from '../src/modules/ingestion/chunker.js';
import { contentHash } from '../src/modules/ingestion/content-hash.js';
import { DocumentExtractorService } from '../src/modules/ingestion/document-extractor.service.js';
import {
  assertEmbeddingColumnIdentifier,
  resolveEmbeddingColumnRef,
} from '../src/modules/reindex/embedding-columns.js';

const POLICIES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'content',
  'policies',
);
const MARKDOWN_TYPE = 'text/markdown';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`seed:policies: missing required environment variable ${name}`);
  }
  return value;
}

function policySource(locale: string, slug: string): string {
  return `seed:policy:${locale}:${slug}`;
}

/** First `# heading` of the markdown, falling back to the file slug. */
function policyTitle(markdown: string, slug: string): string {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      const heading = trimmed
        .slice(2)
        .trim()
        .replace(/\s+—\s+.*$/, '');
      if (heading.length > 0) {
        return heading.slice(0, 200);
      }
    }
  }
  return slug;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed:policies: refusing to run with NODE_ENV=production');
  }
  const locales = (await readdir(POLICIES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (locales.length === 0) {
    throw new Error(`seed:policies: no locale directories in ${POLICIES_DIR}`);
  }

  const config = parseEnv();
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
    for (const locale of locales) {
      const files = (await readdir(join(POLICIES_DIR, locale)))
        .filter((file) => file.endsWith('.md'))
        .sort();
      for (const file of files) {
        const slug = basename(file, '.md');
        const markdown = await readFile(join(POLICIES_DIR, locale, file), 'utf8');
        const source = policySource(locale, slug);
        const { text } = await extractor.extract(Buffer.from(markdown, 'utf8'), MARKDOWN_TYPE);
        const hash = contentHash(text);

        const existing = await prisma.document.findFirst({
          where: { source },
          select: { id: true, status: true, contentHash: true },
        });
        if (existing?.status === 'READY' && existing.contentHash === hash) {
          skipped += 1;
          console.log(`seed:policies: ${locale}/${file} → SKIPPED (unchanged)`);
          continue;
        }
        const documentId =
          existing?.id ??
          (
            await prisma.document.create({
              data: {
                type: 'POLICY',
                title: policyTitle(markdown, slug),
                locale,
                productId: null,
                categoryId: null,
                source,
                contentHash: 'pending',
                status: 'PENDING',
              },
              select: { id: true },
            })
          ).id;

        await prisma.document.update({
          where: { id: documentId },
          data: {
            type: 'POLICY',
            title: policyTitle(markdown, slug),
            locale,
            status: 'PROCESSING',
            error: null,
          },
        });
        try {
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
            const rows = chunks.map((chunk, index) => ({
              id: randomUUID(),
              documentId,
              productId: null,
              ord: index,
              content: chunk.content,
              locale,
              metadata: {
                productId: null,
                categoryId: null,
                docType: 'POLICY',
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
            data: { status: 'READY', contentHash: hash, error: null },
          });
          ready += 1;
          console.log(`seed:policies: ${locale}/${file} → READY (${String(chunks.length)} chunks)`);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown ingestion failure';
          await prisma.document.update({
            where: { id: documentId },
            data: { status: 'FAILED', error: message.slice(0, 500) },
          });
          throw error;
        }
      }
    }
    console.log(`seed:policies: ok — ingested=${String(ready)} skipped=${String(skipped)}`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
