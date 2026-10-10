import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.js';
import { APP_CONFIG } from '../../../config/app-config.module.js';
import type { AppConfig } from '../../../config/env.schema.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AiProviderError, AiRateLimitError } from '../../ai/ai-provider.error.js';
import { generateJson, LlmJsonError } from '../../ai/common/generate-json.js';
import type { LlmMessage, LlmProvider } from '../../ai/interfaces/llm-provider.interface.js';
import { LLM_PROVIDER } from '../../ai/interfaces/llm-provider.interface.js';
import { resolveLocale } from '../../catalog/catalog.service.js';
import { toAvailability } from '../../inventory/inventory.service.js';
import { RetrievalService, type RetrievalHit } from '../../retrieval/retrieval.service.js';
import { buildCitations } from '../citations.js';
import type { ProductQaCitationDto } from '../dto/advisor.dto.js';
import { ChatSessionsService, type ChatSessionOwner } from '../chat-sessions.service.js';
import { buildClarificationQuestion, IntentService } from '../intent/intent.service.js';
import type { PurchaseIntent } from '../intent/purchase-intent.schema.js';
import {
  buildRecommendUserMessage,
  loadRecommendSystemPrompt,
  renderRecommendSystemPrompt,
  RECOMMEND_EVIDENCE_TOP_N,
} from './prompts/recommend.prompt.js';
import {
  recommendDraftSchema,
  type RecommendDraft,
  type RecommendDraftItem,
  type RecommendInput,
} from './recommend.schemas.js';

/** Closed candidate set size (LLM chooses only within these). */
export const RECOMMEND_MAX_CANDIDATES = 8;
/** Oversampling of the unfiltered hybrid search before partitioning evidence. */
export const RECOMMEND_RETRIEVAL_TOP_N = 30;
/** Brand-match bonus in the deterministic score (see ADR 0032). */
export const RECOMMEND_BRAND_BONUS = 50;

/** One SQL candidate row: product + effective price + availability + score. */
export interface RecommendCandidate {
  id: string;
  name: string;
  slug: string;
  specs: Record<string, unknown>;
  brandName: string;
  categorySlug: string;
  priceAmount: number;
  currency: string;
  available: number;
  imageUrl: string | null;
  score: number;
}

/** One hydrated product card: SQL display data + LLM reason + citations. */
export interface RecommendProductCard {
  productId: string;
  name: string;
  slug: string;
  priceAmount: number;
  currency: string;
  inStock: boolean;
  availableQuantity: number;
  imageUrl: string | null;
  reason: string;
  citations: ProductQaCitationDto[];
}

export interface RecommendResponse {
  message: string;
  products: RecommendProductCard[];
  clarifyingQuestion?: string;
}

interface CandidateRow {
  id: string;
  name: string;
  slug: string;
  specs: Record<string, unknown> | null;
  brandName: string;
  categorySlug: string;
  priceAmount: number;
  priceCurrency: string;
  available: number;
  imageUrl: string | null;
  score: number;
}

/**
 * SQL-ready filters derived from the purchase intent plus the session
 * currency. Price bounds apply ONLY in the session currency (no FX rates
 * exist in the system); bounds stated in another currency are dropped and
 * reported, never converted. Pure, unit-tested in isolation.
 */
export interface CandidateFilters {
  categorySlug?: string;
  maxPrice?: number;
  minPrice?: number;
  brandsInclude: string[];
  brandsExclude: string[];
  specs: Array<{ key: string; value: string | number | boolean }>;
}

export function toCandidateFilters(intent: PurchaseIntent, currency: string): CandidateFilters {
  const inCurrency = (
    price: { amount: number; currency: string } | undefined,
  ): number | undefined =>
    price !== undefined && price.currency === currency ? price.amount : undefined;
  return {
    ...(intent.categorySlug !== undefined ? { categorySlug: intent.categorySlug } : {}),
    ...(inCurrency(intent.maxPrice) !== undefined ? { maxPrice: inCurrency(intent.maxPrice) } : {}),
    ...(inCurrency(intent.minPrice) !== undefined ? { minPrice: inCurrency(intent.minPrice) } : {}),
    brandsInclude: intent.brandsInclude.map((name) => name.toLowerCase()),
    brandsExclude: intent.brandsExclude.map((name) => name.toLowerCase()),
    specs: Object.entries(intent.mustHaveSpecs).map(([key, value]) => ({ key, value })),
  };
}

/**
 * Deterministic score from the ADR 0032 formula, computed in TypeScript for
 * tests and documentation (`score = brandBonus + priceBonus`). The SQL query
 * mirrors this exact formula so ordering is identical.
 */
export function scoreCandidate(
  candidate: { brandName: string; priceAmount: number },
  filters: Pick<CandidateFilters, 'brandsInclude' | 'maxPrice'>,
): number {
  const brandBonus = filters.brandsInclude.includes(candidate.brandName.toLowerCase())
    ? RECOMMEND_BRAND_BONUS
    : 0;
  if (filters.maxPrice === undefined || filters.maxPrice <= 0) {
    return brandBonus;
  }
  const priceBonus = Math.round(
    (100 * (filters.maxPrice - candidate.priceAmount)) / filters.maxPrice,
  );
  return brandBonus + Math.max(0, priceBonus);
}

/** Keeps only items whose productId belongs to the SQL closed set. Pure. */
export function keepValidItems(
  items: readonly RecommendDraftItem[],
  candidateIds: ReadonlySet<string>,
): RecommendDraftItem[] {
  return items.filter((item) => candidateIds.has(item.productId));
}

/**
 * Buying-advisor recommendation (see ADR 0032): the LLM redacts a
 * recommendation over a CLOSED SQL candidate set — it never chooses products,
 * prices or stock.
 *
 * Flow: owned-session check (404 before any cost) → history load + session
 * capacity check → USER turn appended → `IntentService` (LLM extraction +
 * deterministic budget) → clarification when category/budget are missing
 * (no SQL, no drafting LLM) → SQL candidates (ACTIVE, in stock, budget,
 * category, specs; deterministic score, LIMIT 8) → deterministic relax hint
 * when empty (recorded as `no_candidates`) → hybrid evidence partitioned to
 * the candidate set (full-text fallback, then evidence-less) → `generateJson`
 * draft → post-validation (drop unknown ids, regen once, deterministic
 * fallback) → SQL hydration → ASSISTANT turn appended. Price, stock, names
 * and images always come from SQL; no personal data ever reaches the LLM.
 */
@Injectable()
export class RecommendService {
  private readonly logger = new Logger(RecommendService.name);
  private readonly systemTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatSessions: ChatSessionsService,
    private readonly intent: IntentService,
    private readonly retrieval: RetrievalService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    // Fail fast at boot when the versioned prompt is missing.
    this.systemTemplate = loadRecommendSystemPrompt();
  }

  async recommend(
    sessionId: string,
    owner: ChatSessionOwner,
    input: RecommendInput,
  ): Promise<RecommendResponse> {
    await this.chatSessions.assertSessionOwned(sessionId, owner);
    const locale = resolveLocale(
      input.locale,
      this.config.SUPPORTED_LOCALES,
      this.config.DEFAULT_LOCALE,
    );
    const history = await this.chatSessions.getSessionHistory(sessionId, owner);
    if (history.messages.length + 2 > this.config.ADVISOR_SESSION_MAX_MESSAGES) {
      throw new BadRequestException({
        message: `session already holds the maximum of ${String(this.config.ADVISOR_SESSION_MAX_MESSAGES)} messages`,
      });
    }
    await this.chatSessions.addMessage(sessionId, owner, { role: 'USER', content: input.content });

    const turns: LlmMessage[] = [
      ...history.messages.map((message) => ({
        role: message.role === 'ASSISTANT' ? ('assistant' as const) : ('user' as const),
        content: message.content,
      })),
      { role: 'user' as const, content: input.content },
    ];

    let purchaseIntent: PurchaseIntent;
    try {
      purchaseIntent = await this.intent.extractIntent(turns, {
        locale,
        currency: this.resolveCurrency(input.currency),
      });
    } catch (error) {
      if (error instanceof LlmJsonError) {
        // Extraction never converged: ask for the budget instead of guessing.
        return this.answerClarification(sessionId, owner, emptyBudgetIntent(), locale);
      }
      throw mapProviderError(error, this.logger, this.llm.providerName);
    }

    if (
      purchaseIntent.categorySlug === undefined ||
      (purchaseIntent.maxPrice === undefined && purchaseIntent.minPrice === undefined)
    ) {
      return this.answerClarification(sessionId, owner, purchaseIntent, locale);
    }

    const currency = this.resolveCurrency(
      input.currency ?? purchaseIntent.maxPrice?.currency ?? purchaseIntent.minPrice?.currency,
    );
    const filters = toCandidateFilters(purchaseIntent, currency);
    const rows = await this.findCandidates(filters, currency);

    if (rows.length === 0) {
      return this.answerNoCandidates(
        sessionId,
        owner,
        input.content,
        purchaseIntent,
        filters,
        currency,
        locale,
      );
    }

    const evidence = await this.retrieveEvidence(
      [input.content, ...purchaseIntent.useCases].join('\n'),
      new Set(rows.map((row) => row.id)),
      locale,
    );

    const cards = await this.draftRecommendations(
      input.content,
      purchaseIntent.useCases,
      rows,
      evidence,
      locale,
    );
    const message =
      cards.kind === 'llm' ? cards.draft.text : buildDeterministicMessage(rows, locale).text;
    const products =
      cards.kind === 'llm'
        ? this.hydrateCards(rows, cards.items, evidence)
        : this.hydrateDeterministic(rows, evidence);

    await this.chatSessions.addMessage(sessionId, owner, {
      role: 'ASSISTANT',
      content: message,
      citations: products.flatMap((card) => card.citations),
      products,
    });

    // Metadata only: never the prompt, the question or the answer.
    this.logger.debug(
      `advisor recommend: candidates=${String(rows.length)} products=${String(products.length)} kind=${cards.kind} provider=${this.llm.providerName}`,
    );
    return { message, products };
  }

  private async answerClarification(
    sessionId: string,
    owner: ChatSessionOwner,
    purchaseIntent: PurchaseIntent,
    locale: string,
  ): Promise<RecommendResponse> {
    const clarifyingQuestion =
      buildClarificationQuestion(purchaseIntent, locale) ?? fallbackQuestion(locale);
    await this.chatSessions.addMessage(sessionId, owner, {
      role: 'ASSISTANT',
      content: clarifyingQuestion,
      citations: [],
      products: [],
    });
    this.logger.debug('advisor recommend: clarifying question asked');
    return { message: clarifyingQuestion, products: [], clarifyingQuestion };
  }

  private async answerNoCandidates(
    sessionId: string,
    owner: ChatSessionOwner,
    question: string,
    purchaseIntent: PurchaseIntent,
    filters: CandidateFilters,
    currency: string,
    locale: string,
  ): Promise<RecommendResponse> {
    const message = await this.buildRelaxHint(purchaseIntent, filters, currency, locale);
    await this.prisma.unansweredQuery.create({
      data: { query: question, productId: null, sessionId, reason: 'no_candidates' },
    });
    await this.chatSessions.addMessage(sessionId, owner, {
      role: 'ASSISTANT',
      content: message,
      citations: [],
      products: [],
    });
    this.logger.debug('advisor recommend: no candidates, relax hint given');
    return { message, products: [] };
  }

  /**
   * Deterministic relax hint (≤ 3 bounded queries, see ADR 0032): cheapest
   * effective price ignoring the budget → suggest raising it; otherwise counts
   * ignoring specs, then ignoring the category, to name what to relax.
   */
  private async buildRelaxHint(
    purchaseIntent: PurchaseIntent,
    filters: CandidateFilters,
    currency: string,
    locale: string,
  ): Promise<string> {
    const cheapest = await this.cheapestIgnoringPrice(
      { ...filters, maxPrice: undefined, minPrice: undefined },
      currency,
    );
    if (cheapest !== null) {
      return relaxRaiseBudgetMessage(purchaseIntent, cheapest, currency, locale);
    }
    const withoutSpecs = await this.countCandidates({ ...filters, specs: [] }, currency, true);
    if (withoutSpecs > 0) {
      return relaxSpecsMessage(withoutSpecs, locale);
    }
    const withoutCategory = await this.countCandidates(
      { ...filters, specs: [], categorySlug: undefined },
      currency,
      true,
    );
    if (withoutCategory > 0) {
      return relaxCategoryMessage(withoutCategory, locale);
    }
    return relaxGenericMessage(locale);
  }

  private async findCandidates(
    filters: CandidateFilters,
    currency: string,
  ): Promise<RecommendCandidate[]> {
    const rows = await this.prisma.$queryRaw<CandidateRow[]>(
      this.buildCandidateQuery(filters, currency, null),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      specs: row.specs ?? {},
      brandName: row.brandName,
      categorySlug: row.categorySlug,
      priceAmount: row.priceAmount,
      currency: row.priceCurrency,
      available: row.available,
      imageUrl: row.imageUrl,
      score: row.score,
    }));
  }

  private async cheapestIgnoringPrice(
    filters: CandidateFilters,
    currency: string,
  ): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ priceAmount: number }>>(
      this.buildCandidateQuery(filters, currency, 'cheapest'),
    );
    const first = rows.at(0);
    return first === undefined ? null : first.priceAmount;
  }

  private async countCandidates(
    filters: CandidateFilters,
    currency: string,
    ignorePrice: boolean,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number | bigint }>>(
      this.buildCandidateQuery(
        ignorePrice ? { ...filters, maxPrice: undefined, minPrice: undefined } : filters,
        currency,
        'count',
      ),
    );
    const first = rows.at(0);
    if (first === undefined) {
      return 0;
    }
    return typeof first.count === 'bigint' ? Number(first.count) : first.count;
  }

  /**
   * Single parameterized candidate query in three shapes (same WHERE,
   * mirrored score): `null` → scored rows LIMIT 8; `'cheapest'` → minimum
   * effective price; `'count'` → match count. Every value travels bound —
   * user input never becomes SQL text.
   */
  buildCandidateQuery(
    filters: CandidateFilters,
    currency: string,
    shape: null | 'cheapest' | 'count',
  ): Prisma.Sql {
    const where = this.buildWhere(filters, currency);
    const score = this.buildScore(filters);
    const from = Prisma.sql`
      FROM "products" "p"
      JOIN "categories" "c" ON "c"."id" = "p"."category_id"
      JOIN "brands" "b" ON "b"."id" = "p"."brand_id"
      LEFT JOIN "product_prices" "pp" ON "pp"."product_id" = "p"."id" AND "pp"."currency" = ${currency}
      LEFT JOIN "inventory" "i" ON "i"."product_id" = "p"."id"
    `;
    if (shape === 'count') {
      return Prisma.sql`SELECT COUNT(*) AS "count" ${from} WHERE ${Prisma.join(where, ' AND ')}`;
    }
    const effectivePrice = Prisma.sql`COALESCE("pp"."amount", "p"."price_amount")`;
    if (shape === 'cheapest') {
      return Prisma.sql`SELECT ${effectivePrice} AS "priceAmount" ${from} WHERE ${Prisma.join(where, ' AND ')} ORDER BY "priceAmount" ASC, "p"."id" ASC LIMIT 1`;
    }
    return Prisma.sql`
      SELECT "p"."id" AS "id", "p"."name" AS "name", "p"."slug" AS "slug",
        "p"."specs" AS "specs", "b"."name" AS "brandName", "c"."slug" AS "categorySlug",
        ${effectivePrice} AS "priceAmount",
        (CASE WHEN "pp"."amount" IS NOT NULL THEN "pp"."currency" ELSE "p"."currency" END) AS "priceCurrency",
        COALESCE("i"."stock" - "i"."reserved", 0) AS "available",
        "img"."url" AS "imageUrl",
        (${score}) AS "score"
      ${from}
      LEFT JOIN LATERAL (
        SELECT "url" FROM "product_images" WHERE "product_id" = "p"."id" ORDER BY "position" ASC LIMIT 1
      ) "img" ON TRUE
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY "score" DESC, "priceAmount" ASC, "p"."id" ASC
      LIMIT ${RECOMMEND_MAX_CANDIDATES}
    `;
  }

  /**
   * Hard SQL filters: ACTIVE + in stock + price in the session currency +
   * category + brands + required specs. Only chunks of reality the database
   * can prove — the LLM never adds or removes candidates.
   */
  private buildWhere(filters: CandidateFilters, currency: string): Prisma.Sql[] {
    const effectivePrice = Prisma.sql`COALESCE("pp"."amount", "p"."price_amount")`;
    const parts: Prisma.Sql[] = [
      Prisma.sql`"p"."status" = 'ACTIVE'`,
      Prisma.sql`COALESCE("i"."stock" - "i"."reserved", 0) > 0`,
      Prisma.sql`("p"."currency" = ${currency} OR "pp"."amount" IS NOT NULL)`,
    ];
    if (filters.categorySlug !== undefined) {
      parts.push(Prisma.sql`"c"."slug" = ${filters.categorySlug}`);
    }
    if (filters.brandsInclude.length > 0) {
      parts.push(
        Prisma.sql`LOWER("b"."name") IN (${Prisma.join(filters.brandsInclude.map((name) => Prisma.sql`${name}`))})`,
      );
    }
    if (filters.brandsExclude.length > 0) {
      parts.push(
        Prisma.sql`NOT (LOWER("b"."name") IN (${Prisma.join(filters.brandsExclude.map((name) => Prisma.sql`${name}`))}))`,
      );
    }
    if (filters.maxPrice !== undefined) {
      parts.push(Prisma.sql`${effectivePrice} <= ${filters.maxPrice}`);
    }
    if (filters.minPrice !== undefined) {
      parts.push(Prisma.sql`${effectivePrice} >= ${filters.minPrice}`);
    }
    for (const spec of filters.specs) {
      parts.push(buildSpecCondition(spec.key, spec.value));
    }
    return parts;
  }

  /**
   * Deterministic score mirrored from `scoreCandidate` (ADR 0032):
   * `brandBonus (50 on preferred brand) + priceBonus (0..100 cheaper is
   * better within the budget, 0 without a budget)`.
   */
  private buildScore(filters: CandidateFilters): Prisma.Sql {
    const effectivePrice = Prisma.sql`COALESCE("pp"."amount", "p"."price_amount")`;
    const brandBonus =
      filters.brandsInclude.length > 0
        ? Prisma.sql`(CASE WHEN LOWER("b"."name") IN (${Prisma.join(filters.brandsInclude.map((name) => Prisma.sql`${name}`))}) THEN ${RECOMMEND_BRAND_BONUS} ELSE 0 END)`
        : Prisma.sql`0`;
    const priceBonus =
      filters.maxPrice !== undefined && filters.maxPrice > 0
        ? Prisma.sql`COALESCE(ROUND(100.0 * (${filters.maxPrice} - ${effectivePrice}) / NULLIF(${filters.maxPrice}, 0))::integer, 0)`
        : Prisma.sql`0`;
    return Prisma.sql`${brandBonus} + ${priceBonus}`;
  }

  /**
   * Hybrid evidence partitioned to the closed set: hits on the candidate
   * products plus product-less (category/policy) hits, cut at
   * `RECOMMEND_EVIDENCE_TOP_N`. Degrades to full-text-only and then to no
   * evidence when the embedding provider fails — citations stay empty rather
   * than invented (see ADR 0032).
   */
  private async retrieveEvidence(
    query: string,
    candidateIds: ReadonlySet<string>,
    locale: string,
  ): Promise<RetrievalHit[]> {
    let hits: RetrievalHit[];
    try {
      hits = await this.retrieval.search({ query, locale, topN: RECOMMEND_RETRIEVAL_TOP_N });
    } catch {
      try {
        hits = await this.retrieval.searchFulltextOnly({
          query,
          locale,
          topN: RECOMMEND_RETRIEVAL_TOP_N,
        });
      } catch {
        this.logger.warn('advisor recommend: retrieval unavailable, drafting without evidence');
        return [];
      }
    }
    return [
      ...hits.filter((hit) => hit.productId !== null && candidateIds.has(hit.productId)),
      ...hits.filter((hit) => hit.productId === null),
    ].slice(0, RECOMMEND_EVIDENCE_TOP_N);
  }

  private async draftRecommendations(
    question: string,
    useCases: readonly string[],
    rows: RecommendCandidate[],
    evidence: RetrievalHit[],
    locale: string,
  ): Promise<
    { kind: 'llm'; draft: RecommendDraft; items: RecommendDraftItem[] } | { kind: 'fallback' }
  > {
    const candidateIds = new Set(rows.map((row) => row.id));
    const system = renderRecommendSystemPrompt(this.systemTemplate, locale);
    const userMessage = buildRecommendUserMessage({
      question,
      useCases,
      candidates: rows.map((row) => ({ id: row.id, name: row.name, specs: row.specs })),
      hits: evidence,
    });
    let draft: RecommendDraft;
    try {
      draft = await this.generateDraft(system, userMessage);
    } catch (error) {
      if (error instanceof LlmJsonError) {
        // Malformed structured output after the built-in retry: deterministic list.
        this.logger.warn('advisor recommend: draft JSON invalid, using deterministic list');
        return { kind: 'fallback' };
      }
      throw error;
    }
    if (draft.items.some((item) => !candidateIds.has(item.productId))) {
      // Post-validation failed: regenerate ONCE with the allowed ids named.
      const allowed = [...candidateIds].join(', ');
      try {
        draft = await this.generateDraft(
          system,
          `${userMessage}\n\nCORRECTION: your previous response mentioned products outside the closed set. Recommend ONLY these product ids: ${allowed}. Reply with ONLY the corrected JSON object.`,
        );
      } catch (error) {
        if (error instanceof LlmJsonError) {
          return { kind: 'fallback' };
        }
        throw error;
      }
      if (
        draft.items.some((item) => !candidateIds.has(item.productId)) ||
        draft.items.length === 0
      ) {
        return { kind: 'fallback' };
      }
      return { kind: 'llm', draft, items: draft.items };
    }
    if (draft.items.length === 0) {
      return { kind: 'fallback' };
    }
    return { kind: 'llm', draft, items: draft.items };
  }

  /**
   * LLM call with provider-failure mapping (see ADR 0026): outages become
   * uniform 503 (429 on provider rate limits). Only metadata reaches the
   * logs — never prompts or keys.
   */
  private async generateDraft(system: string, userMessage: string): Promise<RecommendDraft> {
    try {
      return (
        await generateJson(this.llm, recommendDraftSchema, {
          system,
          messages: [{ role: 'user', content: userMessage }],
        })
      ).data;
    } catch (error) {
      throw mapProviderError(error, this.logger, this.llm.providerName);
    }
  }

  /**
   * Hydrates validated items from the SQL rows (score order). The rows were
   * already filtered by SQL, but availability is re-checked here so a race
   * between the candidate query and hydration can never surface an
   * out-of-stock or non-active product.
   */
  private hydrateCards(
    rows: RecommendCandidate[],
    items: readonly RecommendDraftItem[],
    evidence: RetrievalHit[],
  ): RecommendProductCard[] {
    const cards: RecommendProductCard[] = [];
    for (const row of rows) {
      const item = items.find((entry) => entry.productId === row.id);
      if (item === undefined) {
        continue;
      }
      const card = toProductCard(row, item.reason, resolveItemCitations(item, evidence));
      if (card !== null) {
        cards.push(card);
      }
    }
    return cards;
  }

  private hydrateDeterministic(
    rows: RecommendCandidate[],
    evidence: RetrievalHit[],
  ): RecommendProductCard[] {
    const cards: RecommendProductCard[] = [];
    for (const row of rows) {
      const firstChunk = evidence.findIndex((hit) => hit.productId === row.id);
      const citations =
        firstChunk === -1 ? [] : buildCitations(`[${String(firstChunk + 1)}]`, evidence);
      const card = toProductCard(row, summarizeSpecs(row.specs), citations);
      if (card !== null) {
        cards.push(card);
      }
    }
    return cards;
  }

  private resolveCurrency(requested: string | undefined): string {
    const candidate = (requested ?? this.config.BASE_CURRENCY).trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(candidate) && this.config.SUPPORTED_CURRENCIES.includes(candidate)) {
      return candidate;
    }
    return this.config.BASE_CURRENCY;
  }
}

/**
 * One SQL spec condition (see ADR 0032): case-insensitive equality for text,
 * equality for booleans, `>=` with a numeric guard for numbers. The key
 * travels as a bound parameter — never SQL text.
 */
export function buildSpecCondition(key: string, value: string | number | boolean): Prisma.Sql {
  if (typeof value === 'number') {
    return Prisma.sql`(CASE WHEN ("p"."specs" ->> ${key}) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ((("p"."specs" ->> ${key}))::numeric >= ${value}) ELSE FALSE END)`;
  }
  if (typeof value === 'boolean') {
    return Prisma.sql`(LOWER("p"."specs" ->> ${key}) = ${value ? 'true' : 'false'})`;
  }
  return Prisma.sql`(LOWER("p"."specs" ->> ${key}) = LOWER(${value}))`;
}

/** Resolves an item's `[n]` citations against the delivered evidence. Pure. */
export function resolveItemCitations(
  item: Pick<RecommendDraftItem, 'citations'>,
  evidence: RetrievalHit[],
): ProductQaCitationDto[] {
  return buildCitations(item.citations.map((n) => `[${String(n)}]`).join(' '), evidence);
}

/** Maps one SQL candidate to its display card, or null when unavailable. Pure. */
export function toProductCard(
  row: RecommendCandidate,
  reason: string,
  citations: ProductQaCitationDto[],
): RecommendProductCard | null {
  const availability = toAvailability(row.available);
  if (!availability.inStock) {
    return null;
  }
  return {
    productId: row.id,
    name: row.name,
    slug: row.slug,
    priceAmount: row.priceAmount,
    currency: row.currency,
    inStock: availability.inStock,
    availableQuantity: availability.availableQuantity,
    imageUrl: row.imageUrl,
    reason,
    citations,
  };
}

/** Deterministic spec summary used for fallback reasons. Pure. */
export function summarizeSpecs(specs: Record<string, unknown>): string {
  const entries = Object.entries(specs).slice(0, 4);
  if (entries.length === 0) {
    return 'características en la ficha del producto';
  }
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
}

/**
 * Deterministic fallback message listing the score-ordered candidates with
 * their SQL specs — no LLM redaction involved. Pure, unit-testable.
 */
export function buildDeterministicMessage(
  rows: RecommendCandidate[],
  locale: string,
): { text: string } {
  const spanish = locale.toLowerCase().startsWith('es');
  const lines = rows.map(
    (row, index) => `${String(index + 1)}. ${row.name} (${summarizeSpecs(row.specs)})`,
  );
  const text = spanish
    ? `Según tu presupuesto y filtros, estas son las mejores opciones disponibles:\n${lines.join('\n')}`
    : `Based on your budget and filters, these are the best available options:\n${lines.join('\n')}`;
  return { text };
}

function emptyBudgetIntent(): PurchaseIntent {
  return {
    useCases: [],
    mustHaveSpecs: {},
    brandsInclude: [],
    brandsExclude: [],
    missingInfo: ['budget'],
  };
}

function fallbackQuestion(locale: string): string {
  return locale.toLowerCase().startsWith('es')
    ? '¿Cuál es tu presupuesto máximo (y en qué moneda)?'
    : 'What is your maximum budget (and in which currency)?';
}

function relaxRaiseBudgetMessage(
  purchaseIntent: PurchaseIntent,
  cheapestMinor: number,
  currency: string,
  locale: string,
): string {
  const spanish = locale.toLowerCase().startsWith('es');
  const category = purchaseIntent.categorySlug ?? (spanish ? 'productos' : 'products');
  const max =
    purchaseIntent.maxPrice !== undefined
      ? formatMinorUnits(purchaseIntent.maxPrice.amount, purchaseIntent.maxPrice.currency, locale)
      : null;
  const cheapest = formatMinorUnits(cheapestMinor, currency, locale);
  if (spanish) {
    return (
      `No encontré ${category} por ${max !== null ? `hasta ${max}` : 'ese presupuesto'}. ` +
      `El más económico similar cuesta ${cheapest}: prueba subir tu presupuesto a ${cheapest}.`
    );
  }
  return (
    `I found no ${category} for ${max !== null ? `up to ${max}` : 'that budget'}. ` +
    `The cheapest similar one costs ${cheapest}: try raising your budget to ${cheapest}.`
  );
}

function relaxSpecsMessage(count: number, locale: string): string {
  return locale.toLowerCase().startsWith('es')
    ? `Con esas características no hay opciones disponibles (hay ${String(count)} si quitas algún requisito). Prueba relajando algún requisito como la RAM o el almacenamiento.`
    : `No options match those specifications (${String(count)} exist if you drop a requirement). Try relaxing a requirement such as RAM or storage.`;
}

function relaxCategoryMessage(count: number, locale: string): string {
  return locale.toLowerCase().startsWith('es')
    ? `No hay opciones en esa categoría con esos filtros (hay ${String(count)} en otras categorías). Prueba con una categoría más amplia.`
    : `No options exist in that category with those filters (${String(count)} exist in other categories). Try a broader category.`;
}

function relaxGenericMessage(locale: string): string {
  return locale.toLowerCase().startsWith('es')
    ? 'No encontré productos con esos filtros. Prueba subir tu presupuesto o ampliar la categoría.'
    : 'I found no products with those filters. Try raising your budget or broadening the category.';
}

/**
 * Formats integer minor units for user-facing relax hints (presentation
 * layer, `Intl.NumberFormat` like the frontend). Zero-decimal currencies
 * keep whole units (same set as `payments/stripe-amount.ts`).
 */
export function formatMinorUnits(amount: number, currency: string, locale: string): string {
  const zeroDecimal = new Set([
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
  const major = zeroDecimal.has(currency.toUpperCase()) ? amount : amount / 100;
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(major);
}

function mapProviderError(error: unknown, logger: Logger, providerName: string): unknown {
  if (error instanceof LlmJsonError) {
    return error;
  }
  if (error instanceof AiRateLimitError) {
    logger.warn(`advisor recommend: provider rate limited provider=${error.provider}`);
    return new HttpException(
      { message: 'Advisor provider rate limited, try again later' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  if (error instanceof AiProviderError) {
    logger.warn(`advisor recommend: provider failed code=${error.code} provider=${providerName}`);
    return new ServiceUnavailableException({
      message: 'Advisor provider unavailable, try again later',
    });
  }
  return error;
}
