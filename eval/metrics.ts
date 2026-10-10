/**
 * Pure RAG-evaluation metrics (Fase 7).
 *
 * Every function is deterministic and dependency-free so the numbers mean
 * the same thing no matter which LLM or embedding provider produced the
 * underlying retrieval/answers. Unit-tested in `metrics.spec.ts`.
 */

/** Recall@k over one case: fraction of expected ids present in the top-k. */
export function recallAtK(expected: string[], retrievedTopK: string[]): number | null {
  if (expected.length === 0) {
    return null;
  }
  const top = new Set(retrievedTopK);
  const found = expected.filter((id) => top.has(id)).length;
  return found / expected.length;
}

/** Reciprocal rank of the first expected id in the full ranking (0 = absent). */
export function reciprocalRank(expected: string[], ranking: string[]): number | null {
  if (expected.length === 0) {
    return null;
  }
  const wanted = new Set(expected);
  for (const [index, id] of ranking.entries()) {
    if (wanted.has(id)) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Nearest-rank percentile (p50, p95...). Returns 0 for empty input. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  if (p < 0 || p > 100 || !Number.isFinite(p)) {
    throw new RangeError(`percentile p must be between 0 and 100, got ${String(p)}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)] ?? 0;
}

/** Case-insensitive substring check. */
export function containsFact(answer: string, fact: string): boolean {
  return answer.toLowerCase().includes(fact.toLowerCase());
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Detects price-like spans (`800 USD`, `$12`, `129 EUR`, `19,99 €`) in an
 * answer. Amounts already stated in the user's question are NOT
 * hallucinations (echoing the user's own budget is legitimate); anything
 * else is, because prices must come from SQL, never from the LLM.
 */
export function findHallucinatedPrices(answer: string, question: string): string[] {
  const pricePattern = /\d[\d.,]*\s*(usd|eur|gbp|€|\$|£)|(\$|€|£)\s*\d/gi;
  const questionAmounts = new Set(
    [...question.matchAll(/\d[\d.,]*/g)].map((m) => m[0].replace(/,/g, '')),
  );
  const hallucinated: string[] = [];
  for (const match of answer.matchAll(pricePattern)) {
    const span = match[0];
    const amount = (span.match(/\d[\d.,]*/) ?? [''])[0].replace(/,/g, '');
    if (!questionAmounts.has(amount)) {
      hallucinated.push(span.trim());
    }
  }
  return hallucinated;
}

/**
 * Detects product-id leakage: UUID-looking tokens in the answer that are
 * not in the case's allowlist. Recommendation cards travel in a separate
 * `products` field (SQL-hydrated); ids must never appear in prose.
 */
export function findHallucinatedProductIds(answer: string, allowedIds: string[]): string[] {
  const allowed = new Set(allowedIds.map((id) => id.toLowerCase()));
  const leaked: string[] = [];
  for (const match of answer.matchAll(UUID_PATTERN)) {
    const id = match[0].toLowerCase();
    if (!allowed.has(id) && !leaked.includes(id)) {
      leaked.push(match[0]);
    }
  }
  return leaked;
}

export interface HallucinationCheck {
  hallucinated: boolean;
  detail: string | null;
}

/** Combined product/price hallucination check (rate must be 0). */
export function checkHallucination(
  answer: string,
  question: string,
  allowedProductIds: string[],
): HallucinationCheck {
  const prices = findHallucinatedPrices(answer, question);
  const ids = findHallucinatedProductIds(answer, allowedProductIds);
  const parts: string[] = [];
  if (prices.length > 0) {
    parts.push(`invented prices: ${prices.join(', ')}`);
  }
  if (ids.length > 0) {
    parts.push(`leaked product ids: ${ids.join(', ')}`);
  }
  return {
    hallucinated: parts.length > 0,
    detail: parts.length > 0 ? parts.join('; ') : null,
  };
}

/**
 * Citation validity: every `[n]` marker must resolve to a delivered chunk
 * (`1..deliveredCount`), and cases requiring citations must have ≥1 valid
 * citation. Mirrors the `buildCitations` guardrail (invalid markers are
 * discarded, never surfaced).
 */
export function checkCitationsValid(
  markers: number[],
  deliveredCount: number,
  citationRequired: boolean,
): boolean {
  const allResolve = markers.every((n) => n >= 1 && n <= deliveredCount);
  if (!allResolve) {
    return false;
  }
  if (citationRequired && markers.length === 0) {
    return false;
  }
  return true;
}
