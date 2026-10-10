/**
 * Pure comparison-table builder for `POST /advisor/compare` (see ADR 0035).
 *
 * The table is generated entirely by code from SQL-hydrated products — the
 * LLM never computes it. Rows align spec keys across products (union of
 * keys, sorted; `null` when a product lacks the key) plus a leading price
 * row in minor units. A row highlights its best column(s) only under an
 * objective numeric criterion with complete data; anything else leaves
 * `best` empty so the UI never crowns a winner on vibes.
 */

export type CompareDirection = 'higher' | 'lower';

/** Minimal SQL-hydrated product view the table needs. */
export interface ComparableProduct {
  id: string;
  name: string;
  slug: string;
  priceAmount: number;
  currency: string;
  specs: Record<string, unknown>;
}

/** One table row: aligned values in product (column) order. */
export interface ComparisonRow {
  /** Spec key, or `'price_amount'` for the SQL price row. */
  key: string;
  /** Raw values per product column (`null` = product lacks this spec). */
  values: unknown[];
  /** Column indexes holding the best value (empty when not objective). */
  best: number[];
  /** Objective direction, or `null` for text/enum/incomparable rows. */
  direction: CompareDirection | null;
}

/** Spec keys where a bigger number is objectively better. */
const HIGHER_IS_BETTER = new Set([
  'ram_gb',
  'storage_gb',
  'vram_gb',
  'cores',
  'threads',
  'base_ghz',
  'boost_ghz',
  'boost_mhz',
  'battery_wh',
  'read_mb_s',
  'write_mb_s',
  'speed_mt_s',
  'max_ram_gb',
  'max_ram_speed_mt_s',
  'ram_slots',
  'm2_slots',
  'sata_ports',
  'screen_inches',
]);

/** Spec keys where a smaller number is objectively better. */
const LOWER_IS_BETTER = new Set(['weight_kg']);

/**
 * Builds the comparison table for products in the given (column) order.
 * Pure: no database, no network, no LLM.
 */
export function buildComparisonTable(products: readonly ComparableProduct[]): ComparisonRow[] {
  const rows: ComparisonRow[] = [buildPriceRow(products)];
  for (const key of unionSpecKeys(products)) {
    rows.push(buildSpecRow(key, products));
  }
  return rows;
}

/** Sorted union of every spec key present in any compared product. Pure. */
export function unionSpecKeys(products: readonly ComparableProduct[]): string[] {
  const keys = new Set<string>();
  for (const product of products) {
    for (const key of Object.keys(product.specs)) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

/**
 * Price row from SQL minor units. `best` marks the cheapest column(s) only
 * when every product shares the same currency — minor units across different
 * currencies are not comparable, so mixed currencies leave `best` empty.
 * Pure.
 */
export function buildPriceRow(products: readonly ComparableProduct[]): ComparisonRow {
  const values = products.map((product) => product.priceAmount);
  const sameCurrency =
    products.length > 0 && products.every((product) => product.currency === products[0]?.currency);
  return {
    key: 'price_amount',
    values,
    best: sameCurrency ? argMin(values) : [],
    direction: sameCurrency ? 'lower' : null,
  };
}

function buildSpecRow(key: string, products: readonly ComparableProduct[]): ComparisonRow {
  const values = products.map((product) =>
    Object.hasOwn(product.specs, key) ? (product.specs[key] ?? null) : null,
  );
  const direction = directionOf(key);
  if (direction === null || !values.every(isFiniteNumber)) {
    return { key, values, best: [], direction: null };
  }
  return {
    key,
    values,
    best: direction === 'higher' ? argMax(values) : argMin(values),
    direction,
  };
}

function directionOf(key: string): CompareDirection | null {
  if (HIGHER_IS_BETTER.has(key)) {
    return 'higher';
  }
  if (LOWER_IS_BETTER.has(key)) {
    return 'lower';
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Indexes of the maximal value (ties share the highlight). Pure. */
function argMax(values: readonly number[]): number[] {
  const max = Math.max(...values);
  return values.flatMap((value, index) => (value === max ? [index] : []));
}

/** Indexes of the minimal value (ties share the highlight). Pure. */
function argMin(values: readonly number[]): number[] {
  const min = Math.min(...values);
  return values.flatMap((value, index) => (value === min ? [index] : []));
}

const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * UUIDs mentioned in the LLM summary that are NOT part of the compared set
 * (case-insensitive). An empty result means the summary only mentions the
 * compared products — the post-validation guardrail of ADR 0035. Pure.
 */
export function findForeignUuids(summary: string, allowedIds: ReadonlySet<string>): string[] {
  const allowed = new Set([...allowedIds].map((id) => id.toLowerCase()));
  const foreign: string[] = [];
  const seen = new Set<string>();
  for (const match of summary.match(UUID_PATTERN) ?? []) {
    const lowered = match.toLowerCase();
    if (!allowed.has(lowered) && !seen.has(lowered)) {
      seen.add(lowered);
      foreign.push(match);
    }
  }
  return foreign;
}
