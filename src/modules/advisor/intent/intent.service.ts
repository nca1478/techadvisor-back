import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/app-config.module.js';
import type { AppConfig } from '../../../config/env.schema.js';
import { generateJson } from '../../ai/common/generate-json.js';
import type { LlmMessage, LlmProvider } from '../../ai/interfaces/llm-provider.interface.js';
import { LLM_PROVIDER } from '../../ai/interfaces/llm-provider.interface.js';
import { resolveLocale } from '../../catalog/catalog.service.js';
import { parseBudgetHints } from './budget-parser.js';
import {
  buildIntentUserMessage,
  loadIntentSystemPrompt,
  renderIntentSystemPrompt,
  truncateIntentTurns,
} from './intent.prompt.js';
import {
  KNOWN_CATEGORY_SLUGS,
  KNOWN_SPEC_KEYS,
  purchaseIntentSchema,
  type MissingInfo,
  type PurchaseIntent,
} from './purchase-intent.schema.js';

export interface ExtractIntentOptions {
  /** BCP 47 locale for the clarification language; falls back to DEFAULT_LOCALE. */
  locale?: string;
  /** Session currency (ISO 4217) used when the text names no currency. */
  currency?: string;
}

const ISO_CODE_PATTERN = /^[A-Z]{3}$/;
const MAX_TURNS = 10;

/**
 * Extracts structured purchase constraints from conversation history
 * (see ADR 0031). The LLM only EXTRACTS restrictions — it never recommends
 * products, prices or stock.
 *
 * Flow: resolve locale/currency → deterministic budget parse over USER turns
 * (minor units, no LLM) → versioned prompt + numbered turns → `generateJson`
 * (JSON + Zod + one correction retry) → sanitize (unknown spec keys and
 * unknown categories discarded, never errors) → deterministic budget hint
 * copied over the model budgets → `missingInfo` completed so the advisor can
 * ask exactly ONE clarification question.
 *
 * Controlled failures: `generateJson` throws a typed `LlmJsonError` after
 * its single retry (two provider calls) — callers treat it as "ask a
 * clarification question / try again", never as extracted data. Provider
 * outages (`AiProviderError`) bubble up for the caller to map to 503/429.
 * Only metadata reaches the logs — never conversation text.
 */
@Injectable()
export class IntentService {
  private readonly logger = new Logger(IntentService.name);
  private readonly systemTemplate: string;

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    // Fail fast at boot when the versioned prompt is missing.
    this.systemTemplate = loadIntentSystemPrompt();
  }

  async extractIntent(
    messages: readonly LlmMessage[],
    options: ExtractIntentOptions = {},
  ): Promise<PurchaseIntent> {
    const locale = resolveLocale(
      options.locale,
      this.config.SUPPORTED_LOCALES,
      this.config.DEFAULT_LOCALE,
    );
    const defaultCurrency = this.resolveCurrency(options.currency);
    const turns = truncateIntentTurns(messages, MAX_TURNS);
    const userText = turns
      .filter((turn) => turn.role === 'user')
      .map((turn) => turn.content)
      .join('\n');

    if (userText.trim().length === 0) {
      this.logger.debug('advisor intent: empty conversation, skipped LLM');
      return {
        useCases: [],
        mustHaveSpecs: {},
        brandsInclude: [],
        brandsExclude: [],
        missingInfo: ['category', 'budget', 'use'],
      };
    }

    const budget = parseBudgetHints(userText, defaultCurrency);
    const system = renderIntentSystemPrompt(this.systemTemplate, {
      locale,
      baseCurrency: this.config.BASE_CURRENCY,
      currencies: this.config.SUPPORTED_CURRENCIES,
      categories: KNOWN_CATEGORY_SLUGS,
      specKeys: [...KNOWN_SPEC_KEYS].sort(),
    });

    const { data } = await generateJson(this.llm, purchaseIntentSchema, {
      system,
      messages: [
        {
          role: 'user',
          content: buildIntentUserMessage({ turns, budget, locale, currency: defaultCurrency }),
        },
      ],
    });

    const sanitized = sanitizeIntent(data);
    if (budget.maxPrice !== undefined) {
      sanitized.maxPrice = budget.maxPrice;
    }
    if (budget.minPrice !== undefined) {
      sanitized.minPrice = budget.minPrice;
    }
    completeMissingInfo(sanitized);

    this.logger.debug(
      `advisor intent: extracted turns=${String(turns.length)} ` +
        `category=${sanitized.categorySlug ?? 'none'} ` +
        `budget=${sanitized.maxPrice !== undefined || sanitized.minPrice !== undefined ? 'yes' : 'no'} ` +
        `provider=${this.llm.providerName}`,
    );
    return sanitized;
  }

  private resolveCurrency(requested: string | undefined): string {
    const candidate = (requested ?? this.config.BASE_CURRENCY).trim().toUpperCase();
    return ISO_CODE_PATTERN.test(candidate) ? candidate : this.config.BASE_CURRENCY;
  }
}

/**
 * Drops everything the model invented outside the known vocabularies:
 * unknown `categorySlug` values become `undefined`, unknown
 * `mustHaveSpecs` keys are removed, lists are trimmed/deduplicated and
 * `missingInfo` is restricted to its enum. Pure, unit-tested in isolation.
 */
export function sanitizeIntent(intent: PurchaseIntent): PurchaseIntent {
  const categorySlug =
    intent.categorySlug !== undefined && KNOWN_CATEGORY_SLUGS.includes(intent.categorySlug)
      ? intent.categorySlug
      : undefined;
  const mustHaveSpecs: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(intent.mustHaveSpecs)) {
    if (KNOWN_SPEC_KEYS.has(key) && isSpecScalar(value)) {
      mustHaveSpecs[key] = value;
    }
  }
  return {
    ...(categorySlug !== undefined ? { categorySlug } : {}),
    ...(intent.maxPrice !== undefined ? { maxPrice: intent.maxPrice } : {}),
    ...(intent.minPrice !== undefined ? { minPrice: intent.minPrice } : {}),
    useCases: dedupeStrings(intent.useCases),
    mustHaveSpecs,
    brandsInclude: dedupeStrings(intent.brandsInclude),
    brandsExclude: dedupeStrings(intent.brandsExclude),
    missingInfo: [...new Set(intent.missingInfo)],
  };
}

/**
 * Ensures the critical gaps are always reported so the advisor can ask ONE
 * clarification question: `budget` when no bound exists, `use` when no use
 * case exists, `category` when no known category exists. Never removes the
 * model's `brand`/`specs` entries. Pure, unit-tested in isolation.
 */
export function completeMissingInfo(intent: PurchaseIntent): void {
  const missing = new Set<MissingInfo>(intent.missingInfo);
  if (intent.categorySlug === undefined) {
    missing.add('category');
  }
  if (intent.maxPrice === undefined && intent.minPrice === undefined) {
    missing.add('budget');
  }
  if (intent.useCases.length === 0) {
    missing.add('use');
  }
  intent.missingInfo = [...missing];
}

/**
 * Builds the single clarification question for the first critical gap
 * (priority: budget → use → category; `brand`/`specs` never block). Returns
 * `null` when nothing is missing. Spanish for `es*` locales, English
 * otherwise — matching the two UI languages. Pure, unit-testable.
 */
export const CATEGORY_CLARIFICATION_ES =
  '¿Qué tipo de producto buscas (portátil, procesador, memoria, …)?';
export const CATEGORY_CLARIFICATION_EN =
  'Which kind of product are you looking for (laptop, processor, memory, …)?';

/** Display names of the known catalog categories, in slug order. */
const KNOWN_CATEGORY_DISPLAY: ReadonlyArray<{ slug: string; es: string; en: string }> = [
  { slug: 'laptops', es: 'portátiles', en: 'laptops' },
  { slug: 'cpus', es: 'procesadores', en: 'processors' },
  { slug: 'motherboards', es: 'placas base', en: 'motherboards' },
  { slug: 'ram', es: 'memoria RAM', en: 'memory' },
  { slug: 'gpus', es: 'tarjetas gráficas', en: 'graphics cards' },
  { slug: 'storage', es: 'almacenamiento', en: 'storage' },
  { slug: 'psus', es: 'fuentes de poder', en: 'power supplies' },
  { slug: 'monitors', es: 'monitores', en: 'monitors' },
];

/**
 * Whether a stored assistant message is the category clarification
 * question (either locale). Used to detect a repeated turn: when the
 * category still does not resolve afterwards, asking again would loop, so
 * the caller answers terminally instead.
 */
export function isCategoryClarification(content: string): boolean {
  const normalized = content.trim();
  return normalized === CATEGORY_CLARIFICATION_ES || normalized === CATEGORY_CLARIFICATION_EN;
}

/**
 * Terminal answer for an unresolvable category (e.g. headphones: no such
 * category exists in the catalog). Lists what the advisor does cover so the
 * user can redirect — never a repeated question. Pure, unit-testable.
 */
export function buildUnknownCategoryMessage(locale: string): string {
  const spanish = locale.toLowerCase().startsWith('es');
  const names = KNOWN_CATEGORY_DISPLAY.map((entry) => (spanish ? entry.es : entry.en));
  const last = names[names.length - 1] ?? '';
  const list = [...names.slice(0, -1), `${spanish ? 'y' : 'and'} ${last}`].join(', ');
  return spanish
    ? `Parece que buscas un tipo de producto que no está en mi catálogo. Trabajo con: ${list}. ¿Te interesa alguno de ellos?`
    : `It looks like you are looking for a product type outside my catalog. I cover: ${list}. Are you interested in any of them?`;
}

/**
 * Deterministic synonyms per category slug (Spanish + English). Used only
 * to detect a MULTI-category request (e.g. "tarjeta madre, procesador,
 * memoria...") that the single-`categorySlug` intent model cannot represent.
 * Matching is accent- and case-insensitive; short tokens use word
 * boundaries to avoid false positives (e.g. "ram" inside "programa").
 */
const CATEGORY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  laptops: ['laptop', 'portatil', 'notebook'],
  cpus: ['procesador', 'cpu', 'ryzen'],
  motherboards: ['tarjeta madre', 'placa base', 'placa madre', 'motherboard', 'mainboard'],
  ram: ['memoria ram', 'memoria', 'ram', 'ddr4', 'ddr5', 'dimm'],
  gpus: [
    'tarjeta grafica',
    'tarjeta de video',
    'grafica',
    'gpu',
    'geforce',
    'radeon',
    'rtx',
    'gtx',
  ],
  storage: ['disco duro', 'disco solido', 'almacenamiento', 'ssd', 'hdd', 'nvme', 'm.2'],
  psus: ['fuente de poder', 'fuente de alimentacion', 'fuente', 'psu'],
  monitors: ['monitor', 'pantalla'],
};

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function synonymMatches(normalizedText: string, synonym: string): boolean {
  const normalizedSyn = normalizeForMatch(synonym);
  // Short tokens (<=3 chars) require word boundaries; longer ones match
  // as substrings so "tarjeta madre" and "procesadores" both hit.
  if (normalizedSyn.length <= 3) {
    return new RegExp(`\\b${normalizedSyn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(
      normalizedText,
    );
  }
  return normalizedText.includes(normalizedSyn);
}

/**
 * Returns the known category slugs mentioned in the given user texts, in
 * `KNOWN_CATEGORY_DISPLAY` order. Pure, unit-testable. Returns `[]` when
 * nothing matches; callers treat `>= 2` as a multi-category (bundle/build)
 * request the single-category intent model cannot represent.
 */
export function detectMentionedCategories(texts: readonly string[] | string): string[] {
  const combined = typeof texts === 'string' ? texts : texts.join('\n');
  const normalized = normalizeForMatch(combined);
  const found: string[] = [];
  for (const entry of KNOWN_CATEGORY_DISPLAY) {
    const synonyms = CATEGORY_SYNONYMS[entry.slug] ?? [];
    if (synonyms.some((synonym) => synonymMatches(normalized, synonym))) {
      found.push(entry.slug);
    }
  }
  return found;
}

/**
 * Guidance answer for a multi-category request (bundle / PC build). Names
 * the detected categories and asks for ONE category plus budget/use, since
 * the advisor recommends one category at a time. Stable across turns (same
 * input → same message) so it never degrades into the `unknown_category`
 * terminal text. Pure, unit-testable.
 */
export function buildMultiCategoryMessage(locale: string, slugs: readonly string[]): string {
  const spanish = locale.toLowerCase().startsWith('es');
  const namesBySlug = new Map(KNOWN_CATEGORY_DISPLAY.map((entry) => [entry.slug, entry]));
  const detected = slugs
    .map((slug) => namesBySlug.get(slug))
    .filter((entry) => entry !== undefined)
    .map((entry) => (spanish ? entry.es : entry.en));
  const detail = detected.length > 0 ? ` (${detected.join(', ')})` : '';
  return spanish
    ? `Puedo ayudarte con una categoría a la vez. Detecté varias en tu mensaje${detail}. Elige una para empezar e indícame tu presupuesto máximo y su uso principal; luego repetimos con la siguiente.`
    : `I can help with one category at a time. I detected several in your message${detail}. Pick one to start with and tell me your maximum budget and its main use; then we repeat for the next one.`;
}

export function buildClarificationQuestion(intent: PurchaseIntent, locale: string): string | null {
  if (intent.missingInfo.length === 0) {
    return null;
  }
  const spanish = locale.toLowerCase().startsWith('es');
  const first =
    intent.missingInfo.find(
      (entry) => entry === 'budget' || entry === 'use' || entry === 'category',
    ) ?? intent.missingInfo[0];
  switch (first) {
    case 'budget':
      return spanish
        ? '¿Cuál es tu presupuesto máximo (y en qué moneda)?'
        : 'What is your maximum budget (and in which currency)?';
    case 'use':
      return spanish
        ? '¿Para qué vas a usarlo principalmente?'
        : 'What will you mainly use it for?';
    case 'category':
      return spanish ? CATEGORY_CLARIFICATION_ES : CATEGORY_CLARIFICATION_EN;
    case 'brand':
      return spanish
        ? '¿Tienes alguna marca preferida (o alguna que quieras evitar)?'
        : 'Do you have a preferred brand (or one to avoid)?';
    case 'specs':
      return spanish
        ? '¿Hay alguna característica imprescindible (RAM, almacenamiento, …)?'
        : 'Is there any must-have specification (RAM, storage, …)?';
    default:
      return null;
  }
}

function isSpecScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}
