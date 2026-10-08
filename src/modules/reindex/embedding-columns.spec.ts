import { describe, expect, it } from 'vitest';
import {
  assertEmbeddingColumnIdentifier,
  embeddingColumnDdl,
  EmbeddingColumnError,
  resolveEmbeddingColumnRef,
} from './embedding-columns.js';

describe('resolveEmbeddingColumnRef', () => {
  it('routes known widths to their dedicated columns', () => {
    expect(resolveEmbeddingColumnRef(1536)).toEqual({ column: 'embedding', cast: 'vector' });
    expect(resolveEmbeddingColumnRef(2048)).toEqual({
      column: 'embedding_halfvec',
      cast: 'halfvec',
    });
    expect(resolveEmbeddingColumnRef(16)).toEqual({ column: 'embedding_v2', cast: 'vector' });
  });

  it('rejects unknown widths instead of mixing them into one column', () => {
    expect(() => resolveEmbeddingColumnRef(1024)).toThrow(EmbeddingColumnError);
    expect(() => resolveEmbeddingColumnRef(1024)).toThrow(/Unsupported embedding dimensions/);
  });
});

describe('assertEmbeddingColumnIdentifier', () => {
  it('accepts registry column names', () => {
    expect(() => {
      assertEmbeddingColumnIdentifier('embedding_v2');
    }).not.toThrow();
  });

  it('rejects anything that is not a plain snake_case identifier', () => {
    for (const evil of ['embedding"; DROP TABLE chunks;--', 'a b', 'A', 'x'.repeat(64), '']) {
      expect(() => {
        assertEmbeddingColumnIdentifier(evil);
      }).toThrow(EmbeddingColumnError);
    }
  });
});

describe('embeddingColumnDdl', () => {
  it('renders the additive migration template for a new width', () => {
    const ddl = embeddingColumnDdl('embedding_v2', 16, 'vector');

    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "embedding_v2" vector(16)');
    expect(ddl).toContain('USING hnsw ("embedding_v2" vector_cosine_ops)');
  });

  it('refuses suspicious identifiers and out-of-range dimensions', () => {
    expect(() => embeddingColumnDdl('evil"; --', 16, 'vector')).toThrow(EmbeddingColumnError);
    expect(() => embeddingColumnDdl('embedding_v9', 0, 'vector')).toThrow(EmbeddingColumnError);
  });
});
