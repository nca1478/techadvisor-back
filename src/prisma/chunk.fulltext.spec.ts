import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Full-text search over RAG chunks (integration).
 *
 * Requires the Docker Compose PostgreSQL with migrations applied
 * (`docker compose up -d && npx prisma migrate dev`). Covers the task
 * acceptance criteria: Spanish stemming ("portátil" finds "portátiles") and
 * English stemming ("laptop" finds "laptops") via the per-locale `tsv`
 * column maintained by the `chunks_tsv_update` trigger (see ADR 0015).
 *
 * The `tsv` column is declared as `Unsupported` in the Prisma model (drift
 * marker only, see ADR 0049), so all full-text assertions go through
 * `$queryRaw`.
 */
describe('RAG chunks full-text search per locale (integration)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let prisma: PrismaClient;
  let documentId: string;
  let esChunkId: string;
  let enChunkId: string;

  /** Chunk ids (within the fixture document) matching a full-text query. */
  const search = async (query: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "chunks"
      WHERE "document_id" = ${documentId}::uuid
        AND tsv @@ plainto_tsquery(rag_regconfig(locale), ${query})
    `;
    return rows.map((row) => row.id);
  };

  beforeAll(async () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Start the Compose database before running DB tests.',
      );
    }
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

    const document = await prisma.document.create({
      data: {
        type: 'FAQ',
        title: `Full-text fixture ${suffix}`,
        locale: 'es',
        contentHash: `hash-${suffix}`,
        status: 'READY',
      },
    });
    documentId = document.id;

    const esChunk = await prisma.chunk.create({
      data: {
        documentId,
        ord: 0,
        content: 'Los mejores portátiles para estudiantes de ingeniería en oferta',
        locale: 'es',
        metadata: { docType: 'FAQ' },
      },
    });
    const enChunk = await prisma.chunk.create({
      data: {
        documentId,
        ord: 1,
        content: 'Great laptops for engineering students on sale',
        locale: 'en',
        metadata: { docType: 'FAQ' },
      },
    });
    esChunkId = esChunk.id;
    enChunkId = enChunk.id;
  }, 30_000);

  afterAll(async () => {
    // Document delete cascades to its chunks (see migration FK).
    await prisma.document.deleteMany({ where: { id: documentId } });
    await prisma.$disconnect();
  });

  it('finds the Spanish chunk by singular "portátil" (stemming portátiles)', async () => {
    const ids = await search('portátil');
    expect(ids).toContain(esChunkId);
  });

  it('finds the English chunk by singular "laptop" (stemming laptops)', async () => {
    const ids = await search('laptop');
    expect(ids).toContain(enChunkId);
  });

  it('keeps languages independent: each query matches only its chunk', async () => {
    expect(await search('portátil')).toEqual([esChunkId]);
    expect(await search('laptop')).toEqual([enChunkId]);
  });

  it('returns no rows for an unrelated query', async () => {
    await expect(search('smartphone')).resolves.toEqual([]);
  });

  it('refreshes tsv when content changes (trigger on UPDATE)', async () => {
    await prisma.chunk.update({
      where: { id: esChunkId },
      data: { content: 'Teclados mecánicos con retroiluminación para programadores' },
    });
    await expect(search('portátil')).resolves.toEqual([]);
    await expect(search('teclado')).resolves.toEqual([esChunkId]);
  });

  it('has the GIN index backing tsv lookups', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'chunks' AND indexdef LIKE '%USING gin (tsv)%'
    `;
    expect(rows).toEqual([{ indexname: 'chunks_tsv_gin_idx' }]);
  });
});
