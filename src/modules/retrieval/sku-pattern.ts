/**
 * Exact-identifier heuristic for hybrid retrieval (see ADR 0021).
 *
 * SKUs and model names (e.g. `AURORA-X9000`, `RTX4070`, `XPS-13-9310`) are
 * the one signal where lexical match beats semantics: a chunk that mentions
 * the exact identifier is almost certainly the answer, while an embedding
 * may rank a merely similar product higher. When the query carries such a
 * token, `RetrievalService` doubles the full-text RRF weight (1 → 2) so the
 * exact-match chunk surfaces first.
 *
 * A token counts as SKU/model-like when, uppercased, it:
 * - is made only of letters, digits and the separators `-`, `_`, `/`, `.`;
 * - has length >= 4 (short codes like `AM5` or `4K` also match real words
 *   too often to be trusted blindly);
 * - starts with a letter (digit-leading tokens such as `16GB` or `27` are
 *   usually quantities or spec values, not identifiers);
 * - contains at least one digit (this is what separates identifiers such as
 *   `X9000` from ordinary words such as `laptop`).
 *
 * False positives are cheap by design: they only shift ranking weight toward
 * full-text, never filter anything out.
 */

const SEPARATORS = new Set(['-', '_', '/', '.']);

/** True when `token` looks like a SKU or model identifier. */
export function isSkuLikeToken(token: string): boolean {
  const upper = token.toUpperCase();
  if (upper.length < 4) {
    return false;
  }
  const first = upper.charAt(0);
  if (first < 'A' || first > 'Z') {
    return false;
  }
  let hasDigit = false;
  for (const char of upper) {
    const isLetter = char >= 'A' && char <= 'Z';
    const isDigit = char >= '0' && char <= '9';
    if (isDigit) {
      hasDigit = true;
    } else if (!isLetter && !SEPARATORS.has(char)) {
      return false;
    }
  }
  return hasDigit;
}

/**
 * Splits `query` into candidate tokens and returns the distinct SKU-like
 * ones, uppercased, in order of first appearance.
 */
export function extractSkuTokens(query: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const raw of query.split(/[\s,;()[\]{}"']+/u)) {
    const token = raw.toUpperCase().replace(/^[^\dA-Z]+|[^\dA-Z]+$/gu, '');
    if (token.length === 0 || seen.has(token)) {
      continue;
    }
    seen.add(token);
    if (isSkuLikeToken(token)) {
      found.push(token);
    }
  }
  return found;
}

/** True when the query carries at least one SKU/model-like token. */
export function hasSkuPattern(query: string): boolean {
  return extractSkuTokens(query).length > 0;
}
