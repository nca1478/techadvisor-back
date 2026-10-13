import { describe, expect, it } from 'vitest';
import {
  bucketizeCollected,
  buildBucketStarts,
  defaultOverviewStart,
  modeCurrency,
  startOfUtcDay,
  type CollectedRow,
} from './metrics-overview.js';

function row(overrides: Partial<CollectedRow> = {}): CollectedRow {
  return {
    currency: 'USD',
    totalAmount: 45_000,
    createdAt: new Date('2026-10-13T10:15:00.000Z'),
    ...overrides,
  };
}

describe('metrics-overview helpers (pure)', () => {
  it('computes UTC day/hour starts', () => {
    expect(startOfUtcDay(new Date('2026-10-13T15:30:00.000Z'))).toEqual(
      new Date('2026-10-13T00:00:00.000Z'),
    );
    expect(defaultOverviewStart(new Date('2026-10-13T15:30:00.000Z'), 'day')).toEqual(
      new Date('2026-10-07T00:00:00.000Z'),
    );
    expect(defaultOverviewStart(new Date('2026-10-13T15:30:00.000Z'), 'hour')).toEqual(
      new Date('2026-10-13T00:00:00.000Z'),
    );
  });

  it('builds inclusive UTC buckets (24 hours, N days)', () => {
    const hours = buildBucketStarts(
      new Date('2026-10-13T00:00:00.000Z'),
      new Date('2026-10-13T15:30:00.000Z'),
      'hour',
    );
    expect(hours).toHaveLength(24);
    expect(hours[0]).toEqual(new Date('2026-10-13T00:00:00.000Z'));
    expect(hours[23]).toEqual(new Date('2026-10-13T23:00:00.000Z'));

    const days = buildBucketStarts(
      new Date('2026-10-07T00:00:00.000Z'),
      new Date('2026-10-13T15:30:00.000Z'),
      'day',
    );
    expect(days).toHaveLength(7);
    expect(days[6]).toEqual(new Date('2026-10-13T00:00:00.000Z'));
  });

  it('picks the mode currency (first-seen wins ties) or null when empty', () => {
    expect(modeCurrency([row(), row({ currency: 'EUR' }), row({ currency: 'EUR' })])).toBe('EUR');
    expect(modeCurrency([row(), row({ currency: 'EUR' })])).toBe('USD');
    expect(modeCurrency([])).toBeNull();
  });

  it('buckets mode-currency rows, ignoring other currencies and out-of-range rows', () => {
    const starts = buildBucketStarts(
      new Date('2026-10-07T00:00:00.000Z'),
      new Date('2026-10-08T00:00:00.000Z'),
      'day',
    );
    const amounts = bucketizeCollected(
      [
        row({ createdAt: new Date('2026-10-07T10:00:00.000Z'), totalAmount: 10_000 }),
        row({ createdAt: new Date('2026-10-07T11:00:00.000Z'), totalAmount: 20_000 }),
        row({
          createdAt: new Date('2026-10-07T12:00:00.000Z'),
          totalAmount: 5_000,
          currency: 'EUR',
        }),
        row({ createdAt: new Date('2026-10-01T12:00:00.000Z'), totalAmount: 99_000 }),
      ],
      starts,
      'day',
      'USD',
    );
    expect(amounts).toEqual([30_000, 0]);
  });
});
