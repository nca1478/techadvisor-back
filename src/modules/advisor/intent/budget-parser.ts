/**
 * Deterministic budget parser for es/en conversation text (see ADR 0031).
 *
 * Runs BEFORE the LLM so amounts like "máximo 800 dólares", "under $800",
 * "$1.5k USD" or "4 millones de pesos" normalize to integer minor units
 * without model involvement. The LLM output never overrides a detected
 * hint: `IntentService` copies the hint over the model budgets.
 *
 * Anti-false-positive rule: a bare number only counts when it carries
 * currency evidence (ISO code, symbol, currency word) or a budget keyword
 * nearby ("máximo", "under", "presupuesto", "budget", "precio", "price",
 * ...), so "16GB RAM" or "Docker" never become budgets.
 */

export interface ParsedMoney {
  amount: number;
  currency: string;
}

export interface BudgetHint extends ParsedMoney {
  kind: 'max' | 'min';
}

export interface BudgetHints {
  maxPrice?: ParsedMoney;
  minPrice?: ParsedMoney;
}

/** Stripe-compatible zero-decimal set (see `payments/stripe-amount.ts`). */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

const WORD_TO_CURRENCY: Readonly<Record<string, string | null>> = {
  // null = ambiguous without an ISO code nearby: falls back to default.
  dolar: 'USD',
  dólar: 'USD',
  dolares: 'USD',
  dólares: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  bucks: 'USD',
  euro: 'EUR',
  euros: 'EUR',
  peso: null,
  pesos: null,
  libra: 'GBP',
  libras: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
};

const MAX_KEYWORDS = [
  'max',
  'máx',
  'maximo',
  'máximo',
  'maxima',
  'máxima',
  'under',
  'below',
  'less than',
  'up to',
  'hasta',
  'menos de',
  'por debajo',
  'tope',
  'tope de',
  'no más de',
  'no mas de',
  'como máximo',
  'como maximo',
  'presupuesto',
  'budget',
];

const MIN_KEYWORDS = [
  'min',
  'mín',
  'minimo',
  'mínimo',
  'desde',
  'from',
  'over',
  'above',
  'más de',
  'mas de',
  'at least',
  'por lo menos',
  'como mínimo',
  'como minimo',
];

const BUDGET_KEYWORDS = [
  ...MAX_KEYWORDS,
  ...MIN_KEYWORDS,
  'precio',
  'price',
  'cuesta',
  'cuestan',
  'valga',
  'vale',
  'cost',
  'cuánto',
  'cuanto',
  // Range markers signal a budget context ("entre 300 y 800", "between 300 and 800").
  'entre',
  'between',
];

const MILLION_WORDS = new Set(['millon', 'millón', 'millones', 'million', 'millions', 'm']);
const THOUSAND_WORDS = new Set(['mil', 'k']);
const BILLION_WORDS = new Set(['billon', 'billón', 'billones', 'billion', 'billions', 'b']);

const CONTEXT_CHARS = 40;
const POST_CONTEXT_CHARS = 20;

/** Lowercases and strips diacritics so "máximo" and "maximo" compare equal. */
function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary match against normalized text. Substring `includes` is
 * wrong here: "programming" contains "min" and "máximo" contains "max",
 * neither of which is a budget keyword.
 */
function containsKeyword(normalizedText: string, keyword: string): boolean {
  return new RegExp(`\\b${escapeRegExp(norm(keyword))}\\b`).test(normalizedText);
}

/** Distance from the match boundary to the nearest keyword occurrence, if any. */
function nearestKeywordDistance(
  preWindow: string,
  postWindow: string,
  keywords: readonly string[],
): number | null {
  let best: number | null = null;
  for (const keyword of keywords) {
    const pattern = new RegExp(`\\b${escapeRegExp(norm(keyword))}\\b`, 'g');
    for (const match of preWindow.matchAll(pattern)) {
      const distance = preWindow.length - match.index;
      best = best === null ? distance : Math.min(best, distance);
    }
    for (const match of postWindow.matchAll(pattern)) {
      const distance = match.index;
      best = best === null ? distance : Math.min(best, distance);
    }
  }
  return best;
}

/**
 * Converts a major-unit amount to integer minor units (centavos, etc.).
 * Two decimals by default (USD, EUR and every LatAm currency); zero-decimal
 * currencies keep whole units.
 */
export function toMinorUnits(major: number, currency: string): number {
  if (!Number.isFinite(major) || major < 0) {
    throw new RangeError(`major amount must be a finite non-negative number, got ${String(major)}`);
  }
  if (ZERO_DECIMAL.has(currency.toUpperCase())) {
    return Math.round(major);
  }
  return Math.round(major * 100);
}

/**
 * Parses the numeric part plus an optional es/en multiplier word
 * ("k", "mil", "millones", "millions", "m", "billones", ...) into major
 * units. Handles decimal commas ("1,5k", "1,5 millones"), thousand
 * separators ("1,200", "1.200") and mixed forms ("1,200.50").
 */
export function parseMajorAmount(rawNumber: string, multiplierWord?: string): number | null {
  const normalized = normalizeNumberString(rawNumber.trim());
  if (normalized === null) {
    return null;
  }
  const factor = multiplierFactor(multiplierWord);
  const value = normalized * factor;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function multiplierFactor(word?: string): number {
  if (!word) {
    return 1;
  }
  const key = word.toLowerCase().replace(/\./g, '');
  if (BILLION_WORDS.has(key)) {
    return 1e9;
  }
  if (MILLION_WORDS.has(key)) {
    return 1e6;
  }
  if (THOUSAND_WORDS.has(key)) {
    return 1e3;
  }
  return 1;
}

function normalizeNumberString(raw: string): number | null {
  const compact = raw.replace(/\s+/g, '');
  if (!/^\d[\d.,]*$/.test(compact)) {
    return null;
  }
  const hasDot = compact.includes('.');
  const hasComma = compact.includes(',');
  let canonical: string;
  if (hasDot && hasComma) {
    // The last separator is the decimal one ("1,200.50" vs "1.200,50").
    if (compact.lastIndexOf('.') > compact.lastIndexOf(',')) {
      canonical = compact.replace(/,/g, '');
    } else {
      canonical = compact.replace(/\./g, '').replace(',', '.');
    }
  } else if (hasComma) {
    // Single comma: decimal ("1,5") unless it groups exactly 3 digits.
    canonical = /,\d{3}$/.test(compact) ? compact.replace(/,/g, '') : compact.replace(',', '.');
  } else if (hasDot) {
    // Single dot: decimal ("1.5", "1.50") unless it groups 3 digits ("1.500").
    canonical =
      /\.\d{3}$/.test(compact) && compact.replace(/\D/g, '').length > 3
        ? compact.replace(/\./g, '')
        : compact;
  } else {
    canonical = compact;
  }
  const value = Number(canonical);
  return Number.isFinite(value) ? value : null;
}

interface MoneyMatch {
  index: number;
  length: number;
  major: number;
  currency: string | null;
  hasCurrencyEvidence: boolean;
}

/**
 * Extracts min/max budget hints from free text. Returns `{}` when nothing
 * monetary is found. `defaultCurrency` (session currency or `BASE_CURRENCY`)
 * applies whenever the text names no currency ("pesos" included: the word is
 * ambiguous across COP/MXN/ARS, so it never maps to an ISO code by itself).
 */
export function parseBudgetHints(text: string, defaultCurrency: string): BudgetHints {
  const fallback = defaultCurrency.trim().toUpperCase();
  const matches = findMoneyMatches(text);
  if (matches.length === 0) {
    return {};
  }
  const between = /\b(entre|between)\b/i.test(text) && matches.length >= 2;
  // One explicit currency names the whole range ("entre 300 y 800 dólares").
  const sharedExplicit = matches.find((match) => match.currency !== null)?.currency;
  let maxPrice: ParsedMoney | undefined;
  let minPrice: ParsedMoney | undefined;
  matches.forEach((match, position) => {
    if (!match.hasCurrencyEvidence && !hasBudgetKeywordNearby(text, match)) {
      return;
    }
    const currency = (match.currency ?? sharedExplicit ?? fallback).toUpperCase();
    const amount = toMinorUnits(match.major, currency);
    const kind = inferKind(text, match, { between, position });
    if (kind === 'min') {
      minPrice ??= { amount, currency };
    } else {
      maxPrice ??= { amount, currency };
    }
  });
  return {
    ...(maxPrice !== undefined ? { maxPrice } : {}),
    ...(minPrice !== undefined ? { minPrice } : {}),
  };
}

/** First max hint, or the min hint when only a floor was stated. */
export function parseBudgetHint(text: string, defaultCurrency: string): BudgetHint | null {
  const { maxPrice, minPrice } = parseBudgetHints(text, defaultCurrency);
  if (maxPrice !== undefined) {
    return { ...maxPrice, kind: 'max' as const };
  }
  if (minPrice !== undefined) {
    return { ...minPrice, kind: 'min' as const };
  }
  return null;
}

function findMoneyMatches(text: string): MoneyMatch[] {
  const found: MoneyMatch[] = [];
  // Form 1: [symbol] number [multiplier] [de] [currency word/code].
  // The optional "de" covers "4 millones de pesos" / "tope de 800 euros".
  const afterPattern =
    /(US\$|\$|€|£)?\s*(\d[\d.,]*)\s*(millones|millón|millon|millions|million|billones|billón|billon|billions|billion|mil|k|m|b)?\s*(?:de\s+)?(dólares|dolares|dólar|dolar|dollars?|bucks|euros?|pesos?|libras?|pounds?|[A-Z]{3})?/gi;
  // Form 2: code before the amount ("USD 800", "EUR 1.5k").
  const beforePattern =
    /\b([A-Z]{3})\s*\$?\s*(\d[\d.,]*)\s*(millones|millón|millon|millions|million|billones|billón|billon|billions|billion|mil|k|m|b)?/gi;
  for (const match of text.matchAll(beforePattern)) {
    const code = (match.at(1) ?? '').toUpperCase();
    const major = parseMajorAmount(match.at(2) ?? '', match.at(3));
    if (major === null) {
      continue;
    }
    found.push({
      index: match.index,
      length: match.at(0)?.length ?? 0,
      major,
      currency: /^[A-Z]{3}$/.test(code) ? code : null,
      hasCurrencyEvidence: true,
    });
  }
  for (const match of text.matchAll(afterPattern)) {
    const major = parseMajorAmount(match.at(2) ?? '', match.at(3));
    if (major === null) {
      continue;
    }
    // Skip amounts already covered by the code-first form.
    if (found.some((entry) => overlaps(entry, match.index, match.at(0)?.length ?? 0))) {
      continue;
    }
    const symbol = match.at(1) ?? '';
    const word = (match.at(4) ?? '').toLowerCase();
    const currency = currencyFromEvidence(symbol, word, text, match.index);
    found.push({
      index: match.index,
      length: match.at(0)?.length ?? 0,
      major,
      currency,
      // Any explicit marker counts as evidence — even the ambiguous
      // "pesos" (currency then falls back to the session/base currency).
      hasCurrencyEvidence: symbol !== '' || word !== '',
    });
  }
  return found
    .filter((match) => match.major > 0 && match.major <= 1e12)
    .sort((left, right) => left.index - right.index);
}

function overlaps(entry: MoneyMatch, index: number, length: number): boolean {
  return index < entry.index + entry.length && entry.index < index + length;
}

function currencyFromEvidence(
  symbol: string,
  word: string,
  text: string,
  index: number,
): string | null {
  if (symbol === '€') {
    return 'EUR';
  }
  if (symbol === '£') {
    return 'GBP';
  }
  if (symbol === 'US$') {
    return 'USD';
  }
  if (word !== '') {
    if (/^[a-z]{3}$/i.test(word) && /^[A-Z]{3}$/.test(word.toUpperCase())) {
      return word.toUpperCase();
    }
    const mapped: unknown = WORD_TO_CURRENCY[word];
    if (typeof mapped === 'string') {
      return mapped;
    }
  }
  if (symbol === '$') {
    // "$" plus an explicit code nearby ("$800 USD", "$1.5k USD") wins;
    // otherwise the symbol alone is not enough to name a currency.
    const nearby = text.slice(Math.max(0, index - 12), index + 48);
    const code = /\b[A-Z]{3}\b/.exec(nearby.toUpperCase())?.at(0);
    if (code !== undefined) {
      return code;
    }
    return null;
  }
  return null;
}

function hasBudgetKeywordNearby(text: string, match: MoneyMatch): boolean {
  const window = norm(contextWindow(text, match));
  return BUDGET_KEYWORDS.some((keyword) => containsKeyword(window, keyword));
}

function inferKind(
  text: string,
  match: MoneyMatch,
  options: { between: boolean; position: number },
): 'max' | 'min' {
  if (options.between) {
    return options.position === 0 ? 'min' : 'max';
  }
  const preStart = Math.max(0, match.index - CONTEXT_CHARS);
  const postEnd = Math.min(text.length, match.index + match.length + POST_CONTEXT_CHARS);
  const preWindow = norm(text.slice(preStart, match.index));
  const postWindow = norm(text.slice(match.index + match.length, postEnd));
  const minDistance = nearestKeywordDistance(preWindow, postWindow, MIN_KEYWORDS);
  const maxDistance = nearestKeywordDistance(preWindow, postWindow, MAX_KEYWORDS);
  if (minDistance === null) {
    return 'max';
  }
  if (maxDistance === null) {
    return 'min';
  }
  return minDistance < maxDistance ? 'min' : 'max';
}

function contextWindow(text: string, match: MoneyMatch): string {
  const start = Math.max(0, match.index - CONTEXT_CHARS);
  const end = Math.min(text.length, match.index + match.length + CONTEXT_CHARS);
  return text.slice(start, end);
}
