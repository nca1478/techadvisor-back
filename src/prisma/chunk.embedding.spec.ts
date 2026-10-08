import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { FakeEmbeddingAdapter } from '../modules/ai/adapters/fake-embedding.adapter.js';

/**
 * Vector similarity over RAG chunks (integration, ADR 0017).
 *
 * Requires the Docker Compose PostgreSQL with migrations applied
 * (`docker compose up -d && npx prisma migrate dev`). Covers the task
 * acceptance criteria using the OFFLINE fake adapter only (no provider
 * calls, no secrets):
 *
 * - chunks with stored vectors come back ordered by cosine distance
 *   (`embedding <=> $query`), closest first — the expected order is computed
 *   in JS from the vectors as stored (float4-rounded on read-back), so the
 *   assertion is exact, not trusting the fake adapter's randomness;
 * - the HNSW cosine index (`chunks_embedding_hnsw_idx`) exists with
 *   `vector_cosine_ops` and the planner uses it (EXPLAIN);
 * - `embedding_model`/`embedding_dim` persist per chunk and NULL-embedding
 *   rows (pre-embedding chunks) coexist without breaking vector search.
 *
 * The `embedding vector(1536)` column has no Prisma model field (Prisma
 * cannot map `vector`, like `tsvector` in ADR 0015), so all vector writes
 * and reads go through `$queryRaw`/`$executeRaw`.
 */
describe('RAG chunks embedding cosine search (integration)', () => {
  const DIMENSIONS = 1536;
  const MODEL = 'fake-hash-v1';
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

  let prisma: PrismaClient;
  let documentId: string;
  /** Chunk id per fixture key. */
  const chunkIds = new Map<string, string>();
  /** Vectors exactly as stored (parsed back from PostgreSQL float4 text). */
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

  /** Ids ordered by cosine distance to `query`, closest first. */
  const search = async (query: number[]): Promise<Array<{ id: string; distance: number }>> => {
    const rows = await prisma.$queryRaw<Array<{ id: string; distance: number }>>`
      SELECT id, (embedding <=> ${toVectorLiteral(query)}::vector)::float8 AS distance
      FROM "chunks"
      WHERE "document_id" = ${documentId}::uuid AND embedding IS NOT NULL
      ORDER BY embedding <=> ${toVectorLiteral(query)}::vector
    `;
    return rows;
  };

  /** Expected id order for `query`, computed from the stored vectors. */
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
        title: `Embedding fixture ${suffix}`,
        locale: 'es',
        contentHash: `hash-${suffix}`,
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
        SET "embedding" = ${toVectorLiteral(vector)}::vector
        WHERE "id" = ${chunk.id}::uuid
      `;
      chunkIds.set(fixture.key, chunk.id);
    }

    // Chunk without embedding: pre-embedding rows must not break vector search.
    await prisma.chunk.create({
      data: {
        documentId,
        ord: 3,
        content: 'Texto aún sin vectorizar de la garantía extendida',
        locale: 'es',
        metadata: { docType: 'WARRANTY' },
      },
    });

    const rows = await prisma.$queryRaw<Array<{ id: string; embedding: string }>>`
      SELECT id, embedding::text AS embedding
      FROM "chunks"
      WHERE "document_id" = ${documentId}::uuid AND embedding IS NOT NULL
    `;
    const byId = new Map([...chunkIds.entries()].map(([key, id]) => [id, key]));
    for (const row of rows) {
      const key = byId.get(row.id);
      if (key) {
        storedVectors.set(key, parseVector(row.embedding));
      }
    }
    if (storedVectors.size !== fixtures.length) {
      throw new Error(
        `Expected ${String(fixtures.length)} stored vectors, got ${String(storedVectors.size)}`,
      );
    }
  }, 30_000);

  afterAll(async () => {
    // Document delete cascades to its chunks (see migration FK).
    await prisma.document.deleteMany({ where: { id: documentId } });
    await prisma.$disconnect();
  });

  it('persists embedding_model and embedding_dim per chunk', async () => {
    const chunks = await prisma.chunk.findMany({
      where: { documentId },
      orderBy: { ord: 'asc' },
    });

    expect(chunks).toHaveLength(4);
    for (const chunk of chunks.slice(0, 3)) {
      expect(chunk.embeddingModel).toBe(MODEL);
      expect(chunk.embeddingDim).toBe(DIMENSIONS);
    }
    // The unembedded chunk stays NULL (nullable at the start, ADR 0017).
    expect(chunks[3]?.embeddingModel).toBeNull();
    expect(chunks[3]?.embeddingDim).toBeNull();
  });

  it('returns the exact-match chunk first with ~zero distance', async () => {
    const laptop = storedVectors.get('laptop');
    if (!laptop) {
      throw new Error('laptop fixture vector missing');
    }
    const rows = await search(laptop);

    expect(rows.map((row) => row.id)).toEqual(expectedOrder(laptop));
    expect(rows[0]?.id).toBe(chunkIds.get('laptop'));
    expect(rows[0]?.distance).toBeCloseTo(0, 6);
  });

  it('orders every query by cosine distance, closest first', async () => {
    for (const key of ['laptop', 'keyboard', 'monitor'] as const) {
      const query = storedVectors.get(key);
      if (!query) {
        throw new Error(`${key} fixture vector missing`);
      }
      const rows = await search(query);

      // Only embedded chunks match; the NULL-embedding row is skipped.
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.id)).toEqual(expectedOrder(query));
      // Distances are ascending (allow float ties to keep their SQL order).
      const distances = rows.map((row) => row.distance);
      expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    }
  });

  it('creates the HNSW cosine index on the embedding column', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'chunks' AND indexname = 'chunks_embedding_hnsw_idx'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('USING hnsw');
    expect(rows[0]?.indexdef).toContain('vector_cosine_ops');
  });

  it('uses the HNSW index for ORDER BY distance LIMIT queries (EXPLAIN)', async () => {
    const laptop = storedVectors.get('laptop');
    if (!laptop) {
      throw new Error('laptop fixture vector missing');
    }
    // Tiny fixture tables default to seqscan (and the document-scoped shape
    // correctly prefers the document btree for 4 rows), so the EXPLAIN target
    // is the vector-ordering core every retrieval shares — ORDER BY cosine
    // distance + LIMIT — with seqscan disabled. Production-scale tables use
    // the HNSW index for the filtered shape too (see ADR 0017).
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = 'off'`;
      return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
        EXPLAIN SELECT id FROM "chunks"
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${toVectorLiteral(laptop)}::vector
        LIMIT 3
      `;
    });
    const planText = plan.map((row) => row['QUERY PLAN']).join('\n');

    expect(planText).toContain('chunks_embedding_hnsw_idx');
    expect(planText).toMatch(/index scan/i);
  });
});
