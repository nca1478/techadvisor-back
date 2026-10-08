import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from '../interfaces/embedding-provider.interface.js';

/**
 * Deterministic fake embedding adapter — tests and offline development ONLY.
 *
 * Derives a unit-norm vector from SHA-256 hashes of the text (counter-suffixed
 * to fill any dimension), so the same text always yields the same vector and
 * different texts yield different vectors. No network, no secrets, no input
 * logging. Never persists production chunks (see ADR 0016 §model switching:
 * every chunk records its `embedding_model` precisely to avoid mixing).
 */
export class FakeEmbeddingAdapter implements EmbeddingProvider {
  readonly name = 'fake';
  readonly model: string;
  readonly dimensions: number;

  constructor(options: { model?: string; dimensions: number }) {
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
      throw new RangeError(
        `dimensions must be a positive integer, got ${String(options.dimensions)}`,
      );
    }
    this.model = options.model ?? 'fake-hash-v1';
    this.dimensions = options.dimensions;
  }

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((text) => this.embedOne(text)));
  }

  private embedOne(text: string): number[] {
    const raw = new Array<number>(this.dimensions);
    let filled = 0;
    let counter = 0;
    while (filled < this.dimensions) {
      const digest = createHash('sha256')
        .update(`${String(counter)}:${text}`, 'utf8')
        .digest();
      for (const byte of digest) {
        if (filled >= this.dimensions) {
          break;
        }
        // Center bytes around zero so vectors spread over the unit sphere.
        raw[filled] = byte / 127.5 - 1;
        filled += 1;
      }
      counter += 1;
    }
    const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) {
      raw[0] = 1;
      return raw;
    }
    return raw.map((value) => value / norm);
  }
}
