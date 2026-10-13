/**
 * Pure dashboard-aggregation helpers for `GET /admin/metrics/overview`
 * (see ADR 0043). No Prisma here: the service fetches rows, these helpers
 * shape them — so bucket math is unit-testable without a database.
 */
import type { OrderStatus } from '../../generated/prisma/client.js';

/** Orders that already collected money (never PENDING_PAYMENT/CANCELLED). */
export const COLLECTED_ORDER_STATUSES: readonly OrderStatus[] = [
  'PAID',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
];

export type MetricsGranularity = 'hour' | 'day';

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Default range start when the caller omits `from`: the UTC day of `end`
 * for hourly buckets, the last 7 UTC days (inclusive) for daily buckets.
 */
export function defaultOverviewStart(end: Date, granularity: MetricsGranularity): Date {
  if (granularity === 'hour') return startOfUtcDay(end);
  const day = startOfUtcDay(end);
  return new Date(day.getTime() - 6 * 86_400_000);
}

/**
 * UTC bucket starts covering [start, end] inclusive: 24 hourly steps of the
 * `end` day for `hour`, one step per UTC calendar day for `day`.
 */
export function buildBucketStarts(start: Date, end: Date, granularity: MetricsGranularity): Date[] {
  if (granularity === 'hour') {
    const dayStart = startOfUtcDay(end).getTime();
    return Array.from({ length: 24 }, (_, hour) => new Date(dayStart + hour * 3_600_000));
  }
  const first = startOfUtcDay(start).getTime();
  const last = startOfUtcDay(end).getTime();
  const days = Math.max(0, Math.round((last - first) / 86_400_000));
  return Array.from({ length: days + 1 }, (_, day) => new Date(first + day * 86_400_000));
}

export interface CollectedRow {
  currency: string;
  totalAmount: number;
  createdAt: Date;
}

/** Mode currency of collected rows (first-seen wins ties); null when empty. */
export function modeCurrency(rows: CollectedRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1);
  }
  let mode: string | null = null;
  let top = 0;
  for (const [currency, count] of counts) {
    if (count > top) {
      mode = currency;
      top = count;
    }
  }
  return mode;
}

/**
 * Sums mode-currency amounts into their UTC bucket (rows outside the bucket
 * range or in another currency are ignored — same rule as the former
 * frontend sample math, now exact over the full range).
 */
export function bucketizeCollected(
  rows: CollectedRow[],
  starts: Date[],
  granularity: MetricsGranularity,
  currency: string,
): number[] {
  const amounts = starts.map(() => 0);
  if (starts.length === 0) return amounts;
  const step = granularity === 'hour' ? 3_600_000 : 86_400_000;
  const origin = starts[0].getTime();
  for (const row of rows) {
    if (row.currency !== currency) continue;
    const index = Math.floor((row.createdAt.getTime() - origin) / step);
    if (index < 0 || index >= amounts.length) continue;
    const current = amounts[index];
    amounts[index] = current + row.totalAmount;
  }
  return amounts;
}
