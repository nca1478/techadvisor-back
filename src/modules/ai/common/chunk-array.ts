/**
 * Batching helper shared by embedding adapters.
 *
 * Large ingestion payloads are split into fixed-size batches so a single
 * `embed()` call never exceeds provider input limits. Pure function — no
 * network, no logging.
 */
export function splitIntoBatches<T>(items: readonly T[], batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`batchSize must be a positive integer, got ${String(batchSize)}`);
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}
