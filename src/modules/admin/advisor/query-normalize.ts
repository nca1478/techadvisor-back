/**
 * Groups raw user questions by a cheap normalized key (see ADR 0040).
 *
 * Normalization is deliberately simple — lowercase, diacritic folding,
 * punctuation removal, whitespace collapsing — so near-duplicate
 * abstentions ("¿Cuánto dura la batería?", "cuanto dura la bateria")
 * land in the same bucket and the admin panel can rank gaps by frequency.
 * This is a triage heuristic, never a semantic claim: distinct questions
 * that normalize identically stay individually listed under
 * `GET /admin/advisor/unanswered`.
 */
export function normalizeQuery(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export interface QueryGroup<T> {
  /** Normalized bucket key (empty groups are dropped by `groupQueries`). */
  key: string;
  /** First-seen raw question, kept as the human-readable sample. */
  sample: string;
  count: number;
  /** Newest `createdAt` in the bucket (ISO string), for ranking ties. */
  latestAt: string;
  items: T[];
}

/**
 * Buckets rows by `normalizeQuery(getText(row))`, newest first inside each
 * bucket, buckets sorted by count (desc) then recency (desc). Rows whose
 * text normalizes to empty are skipped (never a group of their own).
 */
export function groupQueries<T>(
  rows: T[],
  getText: (row: T) => string,
  getCreatedAt: (row: T) => Date,
): QueryGroup<T>[] {
  const byKey = new Map<string, QueryGroup<T>>();
  for (const row of rows) {
    const key = normalizeQuery(getText(row));
    if (key === '') {
      continue;
    }
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        key,
        sample: getText(row),
        count: 1,
        latestAt: getCreatedAt(row).toISOString(),
        items: [row],
      });
    } else {
      existing.items.push(row);
      existing.count += 1;
      const at = getCreatedAt(row).toISOString();
      if (at > existing.latestAt) {
        existing.latestAt = at;
      }
    }
  }
  return [...byKey.values()].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return right.latestAt.localeCompare(left.latestAt);
  });
}

/**
 * Truncates user-controlled text for minimized admin surfaces (list rows,
 * session excerpts). Pure helper so the limit is enforced in exactly one
 * place; the full text lives only behind the explicit detail endpoints.
 */
export function excerpt(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength).trimEnd()}…`;
}
