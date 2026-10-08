import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { parseEnv } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { FakeEmbeddingAdapter } from '../ai/adapters/fake-embedding.adapter.js';
import { EmbeddingStateService } from './embedding-state.service.js';
import { ReindexService } from './reindex.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';

/**
 * Zero-downtime model switch against the real PostgreSQL (see ADR 0023).
 *
 * Requires the Docker Compose database with migrations applied
 * (`npx prisma migrate deploy`). Uses OFFLINE fake adapters only — no
 * provider calls, no secrets, no Redis (the queue is null; batches run
 * inline via `processBatch`, which is exactly what the BullMQ processor
 * calls).
 *
 * Scenario: corpus embedded with a dim-8 fake (`reindex_src_8` fixture
 * column, standing in for "the previous model's column provisioned by its
 * own earlier migration") switches to a dim-16 fake (`embedding_v2`,
 * provisioned by this task's migration).
 *
 * Proves the task acceptance criteria:
 * - search works with the old model before the switch;
 * - the reindex fills the new column idempotently with per-chunk
 *   `embedding_model`/`embedding_dim`, reporting progress;
 * - search keeps serving the old model while/after reindexing, until the
 *   explicit activation;
 * - activation flips retrieval to the new model; the old model then matches
 *   nothing (never mixed) and the old column is kept, not dropped.
 */

const SOURCE_MODEL = 'fake-8-test';
const SOURCE_DIM = 8;
const SOURCE_COLUMN = 'reindex_src_8';
const TARGET_MODEL = 'fake-16-test';
const TARGET_DIM = 16;

describe('Embedding model switch 8d → 16d (integration)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  // Run-unique token: other suites share this database (parallel workers),
  // so full-text assertions must never match foreign fixtures.
  const skuToken = `ZXQ${suffix.replace(/-/g, '')}`;
  const locale = 'en';
  let prisma: PrismaClient;
  let state: EmbeddingStateService;
  let reindex: ReindexService;
  let retrievalOld: RetrievalService;
  let retrievalNew: RetrievalService;

  const documentIds: string[] = [];
  const chunkIds: string[] = [];
  let jobId = '';
  let productId = '';

  async function writeSourceVector(chunkId: string, vector: number[]): Promise<void> {
    await prisma.$executeRaw(
      Prisma.sql`UPDATE "chunks" SET "reindex_src_8" = ${`[${vector.join(',')}]`}::vector WHERE "id" = ${chunkId}::uuid`,
    );
  }

  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Start the Compose database before running DB tests.',
      );
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    // Offline config: same knobs as env but the fake provider, so provider
    // construction never touches the network.
    const config = parseEnv({ ...process.env, EMBEDDING_PROVIDER: 'fake' });
    state = new EmbeddingStateService(prisma as unknown as PrismaService, config);
    reindex = new ReindexService(prisma as unknown as PrismaService, state, config, null);
    const sourceProvider = new FakeEmbeddingAdapter({
      model: SOURCE_MODEL,
      dimensions: SOURCE_DIM,
    });
    const targetProvider = new FakeEmbeddingAdapter({
      model: TARGET_MODEL,
      dimensions: TARGET_DIM,
    });
    retrievalOld = new RetrievalService(prisma as unknown as PrismaService, sourceProvider, state);
    retrievalNew = new RetrievalService(prisma as unknown as PrismaService, targetProvider, state);

    // Fixture column for the outgoing width — the equivalent of "the earlier
    // migration that provisioned the previous model's column". No HNSW index
    // on purpose: the fixture proves behavior, and tiny tables seqscan
    // anyway (index usage per column is covered by the corpus migrations).
    await prisma.$executeRaw`
      ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "reindex_src_8" vector(8)
    `;

    const brand = await prisma.brand.create({
      data: { name: `Reindex Brand ${suffix}`, slug: `reindex-brand-${suffix}` },
    });
    const category = await prisma.category.create({
      data: { name: `Reindex Cat ${suffix}`, slug: `reindex-cat-${suffix}` },
    });
    const product = await prisma.product.create({
      data: {
        sku: `REINDEX-${suffix}`,
        name: `Reindex Product ${suffix}`,
        slug: `reindex-product-${suffix}`,
        description: 'Model-switch fixture product.',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });
    productId = product.id;

    const document = await prisma.document.create({
      data: {
        productId: product.id,
        type: 'MANUAL',
        title: `Reindex doc ${suffix}`,
        locale: locale,
        source: `test:reindex-${suffix}`,
        contentHash: `hash-${suffix}`,
        status: 'READY',
      },
    });
    documentIds.push(document.id);

    const contents = [
      `The ${skuToken} mainboard exposes four DIMM slots and two M.2 connectors for compact builds.`,
      'General guidance on choosing a power supply with enough headroom for future upgrades.',
      'Troubleshooting steps for firmware updates that stall halfway through flashing.',
    ];
    const embedded = await sourceProvider.embed(contents);
    for (const [ord, content] of contents.entries()) {
      const chunk = await prisma.chunk.create({
        data: {
          documentId: document.id,
          productId: product.id,
          ord,
          content,
          locale,
          metadata: { docType: 'MANUAL' },
          embeddingModel: SOURCE_MODEL,
          embeddingDim: SOURCE_DIM,
        },
      });
      const vector = embedded.at(ord);
      if (vector === undefined) {
        throw new Error('Missing fixture vector');
      }
      await writeSourceVector(chunk.id, vector);
      chunkIds.push(chunk.id);
    }

    // Pin the persisted active pointer to the outgoing model, as a running
    // system would have it before the switch.
    await prisma.ragEmbeddingState.upsert({
      where: { key: 'active' },
      create: {
        key: 'active',
        model: SOURCE_MODEL,
        dim: SOURCE_DIM,
        column: SOURCE_COLUMN,
        cast: 'vector',
      },
      update: { model: SOURCE_MODEL, dim: SOURCE_DIM, column: SOURCE_COLUMN, cast: 'vector' },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.reindexJob.deleteMany({ where: { targetModel: TARGET_MODEL } });
    await prisma.ragEmbeddingState.deleteMany({ where: { key: 'active' } });
    await prisma.document.deleteMany({ where: { id: { in: documentIds } } });
    if (productId !== '') {
      await prisma.product.deleteMany({ where: { id: productId } });
    }
    await prisma.brand.deleteMany({ where: { slug: `reindex-brand-${suffix}` } });
    await prisma.category.deleteMany({ where: { slug: `reindex-cat-${suffix}` } });
    await prisma.$executeRaw`ALTER TABLE "chunks" DROP COLUMN IF EXISTS "reindex_src_8"`;
    await prisma.$disconnect();
  });

  it('searches with the old model before the switch', async () => {
    const hits = await retrievalOld.search({ query: skuToken, topN: 10 });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunkId).toBe(chunkIds[0]);
  });

  it('reindexes every chunk into the new column with progress', async () => {
    const started = await reindex.startReindex({ model: TARGET_MODEL, dimensions: TARGET_DIM });

    // The snapshot covers the whole shared corpus, so concurrent suites may
    // add rows: only the lower bound (our 3 fixtures) is deterministic.
    expect(started).toMatchObject({
      targetModel: TARGET_MODEL,
      targetDim: TARGET_DIM,
      targetColumn: 'embedding_v2',
    });
    expect(started.totalChunks).toBeGreaterThanOrEqual(3);
    jobId = started.jobId;

    // Process the whole live corpus in small batches (writing a vector into
    // a foreign fixture's `embedding_v2` is harmless: tags and the suites'
    // own columns stay untouched). Our 3 chunks must all be updated.
    // Re-listing until COMPLETED also covers rows created after the
    // snapshot; rows deleted between the snapshot and the first listing
    // cannot be covered by any batch — that interleaving is a ~10 ms
    // window against rare discrete deletions (other suites' afterAll),
    // accepted here and noted for operators running parallel suites.
    let updated = 0;
    for (let round = 0; round < 3; round += 1) {
      const liveIds = (
        await prisma.chunk.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
      ).map((row) => row.id);
      if (round === 0) {
        expect(liveIds).toEqual(expect.arrayContaining(chunkIds));
      }
      for (let start = 0; start < liveIds.length; start += 2) {
        const batch = await reindex.processBatch(jobId, liveIds.slice(start, start + 2));
        updated += batch.updated;
        expect(batch.failed).toBe(0);
      }
      const current = await reindex.getProgress(jobId);
      if (current.status === 'COMPLETED') {
        break;
      }
    }
    expect(updated).toBeGreaterThanOrEqual(3);

    // Reprocessing the same ids is a no-op (idempotent, resumable).
    const replay = await reindex.processBatch(jobId, chunkIds);
    expect(replay).toEqual({ updated: 0, skipped: 3, failed: 0 });

    const progress = await reindex.getProgress(jobId);
    expect(progress).toMatchObject({
      status: 'COMPLETED',
      failedChunks: 0,
      percent: 100,
      activatable: true,
    });
    expect(progress.totalChunks).toBeGreaterThanOrEqual(3);
    expect(progress.processedChunks).toBeGreaterThanOrEqual(progress.totalChunks);
    expect(typeof progress.remainingChunks).toBe('number');

    // The reindex never touches model tags or the old column: only the new
    // vectors land, so retrieval keeps serving the old model untouched.
    const tags = await prisma.$queryRaw<Array<{ model: string | null }>>(
      Prisma.sql`SELECT "embedding_model" AS model FROM "chunks" WHERE "id" IN (${Prisma.join(chunkIds.map((id) => Prisma.sql`${id}::uuid`))})`,
    );
    expect(tags).toHaveLength(3);
    for (const row of tags) {
      expect(row.model).toBe(SOURCE_MODEL);
    }
  });

  it('keeps serving the old model after reindexing, before activation', async () => {
    const hits = await retrievalOld.search({ query: skuToken, topN: 10 });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunkId).toBe(chunkIds[0]);
  });

  it('activates the new model and serves it, never mixing models', async () => {
    // A row created after the snapshot (concurrent writer, another model's
    // fixture) lacks target vectors but must NOT block activation: the gate
    // covers exactly the snapshotted set.
    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentIds[0] } });
    const foreign = await prisma.chunk.create({
      data: {
        documentId: document.id,
        productId,
        ord: 99,
        content: `Foreign concurrent fixture mentioning ${skuToken} that must stay invisible to the new model.`,
        locale: locale,
        metadata: {},
        embeddingModel: 'foreign-model-v1',
        embeddingDim: SOURCE_DIM,
      },
    });

    const activated = await reindex.activate(jobId);

    expect(activated).toMatchObject({
      jobId,
      alreadyActive: false,
      model: TARGET_MODEL,
      dim: TARGET_DIM,
      column: 'embedding_v2',
    });

    const hits = await retrievalNew.search({ query: skuToken, topN: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.chunkId).toBe(chunkIds[0]);

    // No mixing: the foreign chunk mentions the query token, yet neither
    // the vector nor the full-text branch leaks it — both scope to the
    // active model, even though all columns coexist in the table.
    expect(hits.map((hit) => hit.chunkId)).not.toContain(foreign.id);

    // The persisted scope governs every wired service: the old provider
    // object now serves the new model identically (never its stale model).
    const legacyHits = await retrievalOld.search({ query: skuToken, topN: 10 });
    expect(legacyHits.map((hit) => hit.chunkId)).toEqual(hits.map((hit) => hit.chunkId));

    // Every chunk carries the new model tag; the old column is kept.
    const idList = Prisma.join(chunkIds.map((id) => Prisma.sql`${id}::uuid`));
    const rows = await prisma.$queryRaw<Array<{ model: string | null; dim: number | null }>>(
      Prisma.sql`SELECT "embedding_model" AS model, "embedding_dim" AS dim FROM "chunks" WHERE "id" IN (${idList})`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ model: TARGET_MODEL, dim: TARGET_DIM });
    }
    const vectors = await prisma.$queryRaw<Array<{ hasNew: boolean; hasOld: boolean }>>(
      Prisma.sql`SELECT ("embedding_v2" IS NOT NULL) AS "hasNew", ("reindex_src_8" IS NOT NULL) AS "hasOld" FROM "chunks" WHERE "id" IN (${idList})`,
    );
    expect(vectors).toHaveLength(3);
    for (const row of vectors) {
      expect(row).toMatchObject({ hasNew: true, hasOld: true });
    }
  });
});
