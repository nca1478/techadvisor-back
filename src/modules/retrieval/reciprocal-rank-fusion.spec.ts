import { describe, expect, it } from 'vitest';
import { fuseRankings } from './reciprocal-rank-fusion.js';

describe('fuseRankings (Reciprocal Rank Fusion)', () => {
  it('ranks an item present in both lists above single-list items', () => {
    const fused = fuseRankings(
      [
        ['a', 'b', 'c'],
        ['b', 'd', 'e'],
      ],
      { k: 60 },
    );

    expect(fused[0]?.id).toBe('b');
    expect(fused).toHaveLength(5);
    // Scores descend.
    const scores = fused.map((entry) => entry.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  it('applies the textbook formula weight / (k + rank)', () => {
    const fused = fuseRankings([['a', 'b']], { k: 60 });

    expect(fused[0]).toEqual({ id: 'a', score: 1 / 61 });
    expect(fused[1]?.score).toBeCloseTo(1 / 62, 12);
  });

  it('honors per-list weights (full-text boost for SKU queries)', () => {
    const single = fuseRankings([['a'], ['b']], { k: 60, weights: [1, 1] });
    expect(single[0]?.id).toBe('a');

    const boosted = fuseRankings([['a'], ['b']], { k: 60, weights: [1, 2] });
    expect(boosted[0]?.id).toBe('b');
    expect(boosted[0]?.score).toBeCloseTo(2 / 61, 12);
  });

  it('counts a duplicated id inside one list once, at its best rank', () => {
    const fused = fuseRankings([['a', 'a', 'b']], { k: 60 });

    expect(fused).toHaveLength(2);
    expect(fused[0]).toEqual({ id: 'a', score: 1 / 61 });
  });

  it('returns [] for no lists and ignores empty lists', () => {
    expect(fuseRankings([])).toEqual([]);
    expect(fuseRankings([[], []])).toEqual([]);
    expect(fuseRankings([[], ['a']])).toEqual([{ id: 'a', score: 1 / 61 }]);
  });

  it('rejects a negative or non-finite k and weights', () => {
    expect(() => fuseRankings([['a']], { k: -1 })).toThrow(RangeError);
    expect(() => fuseRankings([['a']], { k: Number.NaN })).toThrow(RangeError);
    expect(() => fuseRankings([['a']], { weights: [-1] })).toThrow(RangeError);
  });
});
