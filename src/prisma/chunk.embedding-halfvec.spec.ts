import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { FakeEmbeddingAdapter } from '../modules/ai/adapters/fake-embedding.adapter.js';

/**
 * Vector similarity over `embedding_halfvec` (integration, ADR 0018).
 *
 * Requires the Docker Compose PostgreSQL with migrations applied.
 * `nvidia/nemotron-3-embed-1b` returns native 2048 dims, which exceed the
 * pgvector indexed `vector` cap (2000), so the project stores them as
 * `halfvec(2048)` with an HNSW `halfvec_cosine_ops` index. This spec proves
 * — with the OFFLINE fake adapter at 2048 dims (no provider calls, the
 * adapter is dim-agnostic) — that the halfvec column orders by cosine
 * distance closest-first and that the planner uses the HNSW index.
 *
 * Like `embedding`, the halfvec column has no Prisma model field and is
 * written/read via `$queryRaw`/`$executeRaw`.
 */
describe('RAG chunks halfvec cosine search (integration)', () => {
  const DIMENSIONS = 2048;
  const MODEL = 'fake-hash-v1';
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  let prisma: PrismaClient;
  let documentId: string;
  const chunkIds = new Map<string, string>();
  const storedVectors = new Map<string, number[]>();

  const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`;

  const parseVector = (text: string): number[] =>
    text
      .slice(1, -1)
      .split(',')
      .map((part) => Number(part));

  const cosineDistance = (a: number[], b: number[]): number => {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      dot += x * y;
      normA += x * x;
      normB += y * y;
    }
    return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
  };

  const search = async (query: number[]): Promise<Array<{ id: string; distance: number }>> => {
    const rows = await prisma.$queryRaw<Array<{ id: string; distance: number }>>`
      SELECT id, (embedding_halfvec <=> ${toVectorLiteral(query)}::halfvec)::float8 AS distance
      FROM "chunks"
      WHERE "document_id" = ${documentId}::uuid AND embedding_halfvec IS NOT NULL
      ORDER BY embedding_halfvec <=> ${toVectorLiteral(query)}::halfvec
    `;
    return rows;
  };

  const expectedOrder = (query: number[]): string[] =>
    [...storedVectors.entries()]
      .map(([key, vector]) => ({ key, distance: cosineDistance(query, vector) }))
      .sort((left, right) => left.distance - right.distance)
      .map((entry) => String(chunkIds.get(entry.key)));

  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Start the Compose database before running DB tests.',
      );
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    const adapter = new FakeEmbeddingAdapter({ dimensions: DIMENSIONS });

    const document = await prisma.document.create({
      data: {
        type: 'SPEC_SHEET',
        title: `Halfvec fixture ${suffix}`,
        locale: 'es',
        contentHash: `hash-hv-${suffix}`,
        status: 'READY',
      },
    });
    documentId = document.id;

    const fixtures: Array<{ key: string; ord: number; content: string; locale: string }> = [
      {
        key: 'laptop',
        ord: 0,
        content: 'Portátil con 16 GB de RAM y procesador de ocho núcleos para ingeniería',
        locale: 'es',
      },
      {
        key: 'keyboard',
        ord: 1,
        content: 'Mechanical keyboard with hot-swappable switches and RGB backlight',
        locale: 'en',
      },
      {
        key: 'monitor',
        ord: 2,
        content: 'Monitor 4K de 27 pulgadas con panel IPS y 144 Hz de refresco',
        locale: 'es',
      },
    ];
    const vectors = await adapter.embed(fixtures.map((fixture) => fixture.content));
    for (const [index, fixture] of fixtures.entries()) {
      const vector = vectors.at(index);
      if (vector === undefined) {
        throw new Error('Fake adapter returned fewer vectors than texts');
      }
      const chunk = await prisma.chunk.create({
        data: {
          documentId,
          ord: fixture.ord,
          content: fixture.content,
          locale: fixture.locale,
          metadata: { docType: 'SPEC_SHEET' },
          embeddingModel: adapter.model,
          embeddingDim: adapter.dimensions,
        },
      });
      await prisma.$executeRaw`
        UPDATE "chunks"
        SET "embedding_halfvec" = ${toVectorLiteral(vector)}::halfvec
        WHERE "id" = ${chunk.id}::uuid
      `;
      chunkIds.set(fixture.key, chunk.id);
    }

    const rows = await prisma.$queryRaw<Array<{ id: string; embedding_halfvec: string }>>`
      SELECT id, embedding_halfvec::text AS embedding_halfvec
      FROM "chunks"
      WHERE "document_id" = ${documentId}::uuid AND embedding_halfvec IS NOT NULL
    `;
    const byId = new Map([...chunkIds.entries()].map(([key, id]) => [id, key]));
    for (const row of rows) {
      const key = byId.get(row.id);
      if (key) {
        storedVectors.set(key, parseVector(row.embedding_halfvec));
      }
    }
    if (storedVectors.size !== fixtures.length) {
      throw new Error(
        `Expected ${String(fixtures.length)} stored vectors, got ${String(storedVectors.size)}`,
      );
    }
  }, 30_000);

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { id: documentId } });
    await prisma.$disconnect();
  });

  it('persists 2048-dim bookkeeping per chunk (model switch stays explicit)', async () => {
    const chunks = await prisma.chunk.findMany({
      where: { documentId },
      orderBy: { ord: 'asc' },
    });

    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.embeddingModel).toBe(MODEL);
      expect(chunk.embeddingDim).toBe(DIMENSIONS);
    }
  });

  it('orders every query by halfvec cosine distance, closest first', async () => {
    for (const key of ['laptop', 'keyboard', 'monitor'] as const) {
      const query = storedVectors.get(key);
      if (!query) {
        throw new Error(`${key} fixture vector missing`);
      }
      const rows = await search(query);

      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.id)).toEqual(expectedOrder(query));
      expect(rows[0]?.id).toBe(chunkIds.get(key));
      expect(rows[0]?.distance).toBeCloseTo(0, 6);
      const distances = rows.map((row) => row.distance);
      expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    }
  });

  it('creates the HNSW halfvec-cosine index on the halfvec column', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'chunks' AND indexname = 'chunks_embedding_halfvec_hnsw_idx'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('USING hnsw');
    expect(rows[0]?.indexdef).toContain('halfvec_cosine_ops');
  });

  it('uses the halfvec HNSW index for ORDER BY distance LIMIT queries (EXPLAIN)', async () => {
    const laptop = storedVectors.get('laptop');
    if (!laptop) {
      throw new Error('laptop fixture vector missing');
    }
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = 'off'`;
      return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
        EXPLAIN SELECT id FROM "chunks"
        WHERE embedding_halfvec IS NOT NULL
        ORDER BY embedding_halfvec <=> ${toVectorLiteral(laptop)}::halfvec
        LIMIT 3
      `;
    });
    const planText = plan.map((row) => row['QUERY PLAN']).join('\n');

    expect(planText).toContain('chunks_embedding_halfvec_hnsw_idx');
    expect(planText).toMatch(/index scan/i);
  });
});
