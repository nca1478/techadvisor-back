import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { FakeEmbeddingAdapter } from '../ai/adapters/fake-embedding.adapter.js';
import {
  resolveEmbeddingColumn,
  resolveFulltextConfigs,
  RetrievalService,
} from './retrieval.service.js';

const DIMENSIONS = 1536;
const MODEL = 'fake-hash-v1';

interface Row {
  chunkId: string;
  documentId: string;
  productId: string | null;
  content: string;
  locale: string;
  docType: string;
  title: string;
  sourceUrl: string | null;
}

const row = (chunkId: string, content: string): Row => ({
  chunkId,
  documentId: `doc-${chunkId}`,
  productId: null,
  content,
  locale: 'en',
  docType: 'MANUAL',
  title: `Title ${chunkId}`,
  sourceUrl: null,
});

function buildService(
  vectorRows: Row[],
  fulltextRows: Row[],
): {
  service: RetrievalService;
  seen: Prisma.Sql[];
} {
  const seen: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: vi.fn((query: Prisma.Sql) => {
      seen.push(query);
      // First call is the vector branch; the second is the first full-text
      // configuration branch. Later configuration branches return [] so each
      // fixture row counts exactly once in fusion assertions.
      if (seen.length === 1) {
        return Promise.resolve(vectorRows);
      }
      return Promise.resolve(seen.length === 2 ? fulltextRows : []);
    }),
  } as unknown as PrismaService;
  const embeddings = new FakeEmbeddingAdapter({ model: MODEL, dimensions: DIMENSIONS });
  return { service: new RetrievalService(prisma, embeddings), seen };
}

describe('RetrievalService (unit, mocked database)', () => {
  it('rejects an empty query with a 400', async () => {
    const { service } = buildService([], []);

    await expect(service.search({ query: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('scopes the vector branch to the active embedding model', async () => {
    const { service, seen } = buildService([row('a', 'alpha')], []);

    await service.search({ query: 'some laptop question' });

    expect(seen).toHaveLength(3);
    const vectorQuery = seen[0];
    expect(vectorQuery).toBeInstanceOf(Prisma.Sql);
    expect(vectorQuery.sql).toContain('"embedding_model"');
    expect(vectorQuery.values).toContain(MODEL);
  });

  it('boosts the full-text branch when the query carries an SKU token', async () => {
    const { service } = buildService(
      [row('vector-only', 'generic computing tips')],
      [row('sku-chunk', 'Manual for the AURORA-X9000 laptop')],
    );

    const hits = await service.search({ query: 'AURORA-X9000 warranty' });

    expect(hits.map((hit) => hit.chunkId)).toEqual(['sku-chunk', 'vector-only']);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
    expect(hits[0]?.source).toMatchObject({ docType: 'MANUAL' });
  });

  it('returns fused hits with provenance and score', async () => {
    const { service } = buildService([row('a', 'alpha')], [row('a', 'alpha')]);

    const hits = await service.search({ query: 'laptop for students', topN: 5 });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      chunkId: 'a',
      documentId: 'doc-a',
      content: 'alpha',
      source: { title: 'Title a', docType: 'MANUAL', sourceUrl: null },
    });
    expect(hits[0]?.score).toBeCloseTo(1 / 61 + 1 / 61, 12);
  });

  it('honors topN over the fused ranking', async () => {
    const { service } = buildService([row('a', 'alpha'), row('b', 'beta'), row('c', 'gamma')], []);

    const hits = await service.search({ query: 'laptops compared', topN: 2 });

    expect(hits.map((hit) => hit.chunkId)).toEqual(['a', 'b']);
  });
});

describe('resolveEmbeddingColumn', () => {
  it('routes 1536 to vector and 2048 to halfvec, rejecting anything else', () => {
    expect(resolveEmbeddingColumn(1536)).toEqual({ column: 'embedding', cast: 'vector' });
    expect(resolveEmbeddingColumn(2048)).toEqual({ column: 'embedding_halfvec', cast: 'halfvec' });
    expect(() => resolveEmbeddingColumn(1024)).toThrow(/Unsupported embedding dimensions/);
  });
});

describe('resolveFulltextConfigs', () => {
  it('queries both configurations without locale information', () => {
    expect(resolveFulltextConfigs([], undefined)).toEqual(['spanish', 'english']);
  });

  it('maps es* to spanish and anything else to english', () => {
    expect(resolveFulltextConfigs(['es'], undefined)).toEqual(['spanish']);
    expect(resolveFulltextConfigs(['en'], undefined)).toEqual(['english']);
    expect(resolveFulltextConfigs([], 'es-MX')).toEqual(['spanish']);
    expect(resolveFulltextConfigs(['es'], 'en')).toEqual(['spanish', 'english']);
  });
});
