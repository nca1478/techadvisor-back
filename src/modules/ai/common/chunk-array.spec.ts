import { describe, expect, it } from 'vitest';
import { splitIntoBatches } from './chunk-array.js';

describe('splitIntoBatches', () => {
  it('returns batches of the requested size, preserving order', () => {
    expect(splitIntoBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single batch when everything fits', () => {
    expect(splitIntoBatches(['a', 'b'], 100)).toEqual([['a', 'b']]);
  });

  it('returns no batches for an empty input (no HTTP is ever sent)', () => {
    expect(splitIntoBatches([], 10)).toEqual([]);
  });

  it('rejects non-positive batch sizes', () => {
    expect(() => splitIntoBatches([1], 0)).toThrow(RangeError);
    expect(() => splitIntoBatches([1], -3)).toThrow(RangeError);
    expect(() => splitIntoBatches([1], 1.5)).toThrow(RangeError);
  });
});
