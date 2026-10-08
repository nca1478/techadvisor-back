import { describe, expect, it } from 'vitest';
import { FakeEmbeddingAdapter } from './fake-embedding.adapter.js';

const DIM = 16;

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
}

describe('FakeEmbeddingAdapter', () => {
  it('is deterministic for the same text', async () => {
    const adapter = new FakeEmbeddingAdapter({ dimensions: DIM });

    await expect(adapter.embed(['hola mundo'])).resolves.toEqual(
      await adapter.embed(['hola mundo']),
    );
  });

  it('returns EMBEDDING_DIM unit-norm vectors in input order', async () => {
    const adapter = new FakeEmbeddingAdapter({ dimensions: DIM });
    const vectors = await adapter.embed(['one', 'two', 'three']);

    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(DIM);
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      expect(norm).toBeCloseTo(1, 6);
    }
    // Order preserved: re-embedding a single text matches its batch position.
    const [single] = await adapter.embed(['two']);
    expect(single).toEqual(vectors[1]);
  });

  it('separates different texts', async () => {
    const adapter = new FakeEmbeddingAdapter({ dimensions: DIM });
    const vectors = await adapter.embed(['portátil para estudiar', 'placa base AM5']);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).not.toEqual(vectors[1]);
    expect(Math.abs(cosine(vectors[0], vectors[1]))).toBeLessThan(0.99);
  });

  it('returns [] without work for an empty input', async () => {
    const adapter = new FakeEmbeddingAdapter({ dimensions: DIM });

    await expect(adapter.embed([])).resolves.toEqual([]);
  });

  it('rejects non-positive dimensions (never mix dimensions in one column)', () => {
    expect(() => new FakeEmbeddingAdapter({ dimensions: 0 })).toThrow(RangeError);
  });
});
