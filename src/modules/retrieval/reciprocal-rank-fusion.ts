/**
 * Reciprocal Rank Fusion (RRF) for hybrid retrieval (see ADR 0021).
 *
 * Pure function with no I/O: merges the ranked id lists produced by the
 * vector branch and the full-text branch into a single ordering. Each list
 * contributes `weight / (k + rank)` per item (rank is 1-based); items present
 * in several lists accumulate the sum, so consensus across modalities wins.
 *
 * `k` (default 60, parametrizable) dampens the influence of low ranks: a
 * larger `k` flattens score differences between ranks. `weights` lets callers
 * boost one modality (e.g. full-text when the query carries an exact
 * SKU/model token, see `sku-pattern.ts`).
 */
export interface FuseRankingsOptions {
  /** RRF dampening constant. Must be a non-negative finite number. */
  k?: number;
  /** Per-list weight, same order as `rankedLists`. Defaults to 1 each. */
  weights?: number[];
}

export interface FusedRanking {
  id: string;
  score: number;
}

export function fuseRankings(
  rankedLists: string[][],
  options: FuseRankingsOptions = {},
): FusedRanking[] {
  const { k = 60, weights = [] } = options;
  if (!Number.isFinite(k) || k < 0) {
    throw new RangeError(`RRF k must be a non-negative finite number, got ${String(k)}`);
  }
  const scores = new Map<string, number>();
  for (const [listIndex, list] of rankedLists.entries()) {
    const weight = weights[listIndex] ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(
        `RRF weight at index ${String(listIndex)} must be a non-negative finite number, got ${String(weight)}`,
      );
    }
    const seenInList = new Set<string>();
    list.forEach((id, position) => {
      // A duplicated id inside one list counts once, at its best rank.
      if (seenInList.has(id)) {
        return;
      }
      seenInList.add(id);
      const rank = position + 1;
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score);
}
