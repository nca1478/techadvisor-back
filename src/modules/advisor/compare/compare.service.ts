import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { APP_CONFIG } from '../../../config/app-config.module.js';
import type { AppConfig } from '../../../config/env.schema.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AiProviderError, AiRateLimitError } from '../../ai/ai-provider.error.js';
import type { LlmProvider } from '../../ai/interfaces/llm-provider.interface.js';
import { LLM_PROVIDER } from '../../ai/interfaces/llm-provider.interface.js';
import { resolveLocale } from '../../catalog/catalog.service.js';
import { resolveCompatibilityLocale } from '../../compatibility/rules/messages.js';
import { checkCompatibility } from '../../compatibility/rules/rules.js';
import type { CompatibilityResult } from '../../compatibility/rules/compatibility.types.js';
import { RetrievalService, type RetrievalHit } from '../../retrieval/retrieval.service.js';
import { buildCitations } from '../citations.js';
import type { ProductQaCitationDto } from '../dto/advisor.dto.js';
import type { CompareResponseDto } from '../dto/compare.dto.js';
import type { CompareInput } from './compare.schemas.js';
import {
  buildComparisonTable,
  findForeignUuids,
  type ComparableProduct,
  type ComparisonRow,
} from './comparison-table.js';
import {
  buildCompareUserMessage,
  loadCompareSystemPrompt,
  renderCompareSystemPrompt,
} from './prompts/compare.prompt.js';

/** SQL-hydrated compare row: table facts plus the engine's category slug. */
export interface CompareProductRow extends ComparableProduct {
  categorySlug: string;
}

/** Evidence chunks delivered to the comparison prompt (kept small). */
export const COMPARE_EVIDENCE_TOP_N = 12;
/** Per-product oversampling before partitioning evidence to the set. */
export const COMPARE_PRODUCT_TOP_N = 4;
/** Oversampling of the unfiltered search before keeping product-less hits. */
export const COMPARE_GENERAL_TOP_N = 30;

/**
 * Product comparison (see ADR 0035): a code-generated table from SQL plus an
 * LLM-redacted summary over that table and retrieved evidence.
 *
 * Flow: ACTIVE-products check (unknown/DRAFT/ARCHIVED ids 404 before any
 * retrieval or LLM cost) → deterministic table from `specs` + price (SQL) →
 * deterministic compatibility verdict from the ADR 0034 engine (passed as a
 * given FACT, never decided by the LLM) → hybrid evidence partitioned to
 * the compared set (degrading to evidence-less on retrieval failure) →
 * `LlmProvider.generate` → post-validation (summaries mentioning products
 * outside the set regenerate ONCE, then fall back to a deterministic
 * code-built summary). Prices, specs and compatibility always come from SQL
 * and code; no personal data ever reaches the LLM.
 */
@Injectable()
export class CompareService {
  private readonly logger = new Logger(CompareService.name);
  private readonly systemTemplate: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly retrieval: RetrievalService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    // Fail fast at boot when the versioned prompt is missing.
    this.systemTemplate = loadCompareSystemPrompt();
  }

  async compare(input: CompareInput): Promise<CompareResponseDto> {
    const locale = resolveLocale(
      input.locale,
      this.config.SUPPORTED_LOCALES,
      this.config.DEFAULT_LOCALE,
    );
    const products = await this.findActiveProducts(input.productIds);
    const table = buildComparisonTable(products);
    const compatibility = this.checkCompatibility(products, locale);

    const evidence = await this.retrieveEvidence(
      input.useCase ?? products.map((product) => product.name).join(' '),
      new Set(products.map((product) => product.id)),
      locale,
    );

    const system = renderCompareSystemPrompt(this.systemTemplate, locale);
    const userMessage = buildCompareUserMessage({
      products,
      table,
      compatibility,
      hits: evidence,
      ...(input.useCase !== undefined ? { useCase: input.useCase } : {}),
    });
    const summary = await this.generateValidatedSummary(system, userMessage, products, evidence);
    const citations = buildCitations(summary, evidence);

    // Metadata only: never the prompt, the use case or the summary.
    this.logger.debug(
      `advisor compare: products=${String(products.length)} rows=${String(table.length)} citations=${String(citations.length)} compatible=${String(compatibility.compatible)} provider=${this.llm.providerName}`,
    );
    return {
      products: products.map((product) => ({
        productId: product.id,
        name: product.name,
        slug: product.slug,
        priceAmount: product.priceAmount,
        currency: product.currency,
        specs: product.specs,
      })),
      table: table.map((row) => ({
        key: row.key,
        values: row.values,
        best: row.best,
        direction: row.direction,
      })),
      compatibility,
      summary,
      citations,
    };
  }

  /**
   * ACTIVE products only, in request order. Unknown, DRAFT or ARCHIVED ids
   * 404 identically so the endpoint never reveals non-active products.
   * Throws before any retrieval or LLM call.
   */
  private async findActiveProducts(productIds: string[]): Promise<CompareProductRow[]> {
    const rows = await this.prisma.product.findMany({
      where: { id: { in: productIds }, status: 'ACTIVE' },
      include: { category: { select: { slug: true } } },
    });
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    const missing = productIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new NotFoundException({ message: `Products not found: ${missing.join(', ')}` });
    }
    return productIds.map((id) => {
      const row = byId.get(id);
      if (row === undefined) {
        throw new NotFoundException({ message: `Products not found: ${id}` });
      }
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        priceAmount: row.priceAmount,
        currency: row.currency,
        specs: (row.specs ?? {}) as Record<string, unknown>,
        categorySlug: row.category.slug,
      };
    });
  }

  /**
   * Deterministic compatibility verdict over the compared products (ADR
   * 0034 engine, no LLM). The engine input reuses the SQL-hydrated rows so
   * no second query is needed.
   */
  private checkCompatibility(products: CompareProductRow[], locale: string): CompatibilityResult {
    return checkCompatibility(
      products.map((product) => ({
        id: product.id,
        name: product.name,
        categorySlug: product.categorySlug,
        specs: product.specs,
      })),
      resolveCompatibilityLocale(locale),
    );
  }

  /**
   * Hybrid evidence partitioned to the compared set: per-product hits plus
   * product-less (category/policy) hits, deduplicated, best score first, cut
   * at `COMPARE_EVIDENCE_TOP_N`. Degrades to full-text-only and then to no
   * evidence when retrieval fails — the table summary never depends on it.
   */
  private async retrieveEvidence(
    query: string,
    productIds: ReadonlySet<string>,
    locale: string,
  ): Promise<RetrievalHit[]> {
    let pool: RetrievalHit[];
    try {
      const [perProduct, general] = await Promise.all([
        Promise.all(
          [...productIds].map((productId) =>
            this.retrieval.search({
              query,
              filters: { productId },
              locale,
              topN: COMPARE_PRODUCT_TOP_N,
            }),
          ),
        ).then((groups) => groups.flat()),
        this.retrieval.search({ query, locale, topN: COMPARE_GENERAL_TOP_N }),
      ]);
      pool = [...perProduct, ...general.filter((hit) => hit.productId === null)];
    } catch {
      try {
        const hits = await this.retrieval.searchFulltextOnly({
          query,
          locale,
          topN: COMPARE_GENERAL_TOP_N,
        });
        pool = [
          ...hits.filter((hit) => hit.productId !== null && productIds.has(hit.productId)),
          ...hits.filter((hit) => hit.productId === null),
        ];
      } catch {
        this.logger.warn('advisor compare: retrieval unavailable, summarizing without evidence');
        return [];
      }
    }
    const byId = new Map<string, RetrievalHit>();
    for (const hit of pool) {
      if (hit.productId === null || productIds.has(hit.productId)) {
        byId.set(hit.chunkId, hit);
      }
    }
    return [...byId.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, COMPARE_EVIDENCE_TOP_N);
  }

  /**
   * LLM summary with post-validation (see ADR 0035): summaries mentioning a
   * product UUID outside the compared set regenerate ONCE with the allowed
   * ids named; a second violation (or empty text) falls back to a
   * deterministic code-built summary so the response never names products
   * the database did not compare.
   */
  private async generateValidatedSummary(
    system: string,
    userMessage: string,
    products: ComparableProduct[],
    evidence: RetrievalHit[],
  ): Promise<string> {
    const allowedIds = new Set(products.map((product) => product.id));
    const first = await this.generateSummary(system, userMessage);
    if (findForeignUuids(first, allowedIds).length === 0 && first.trim().length > 0) {
      return first;
    }
    const allowed = [...allowedIds].join(', ');
    const second = await this.generateSummary(
      system,
      `${userMessage}\n\nCORRECTION: your previous response mentioned products outside the compared set. Explain ONLY these product ids: ${allowed}. Reply with ONLY the corrected summary.`,
    );
    if (findForeignUuids(second, allowedIds).length === 0 && second.trim().length > 0) {
      return second;
    }
    this.logger.warn('advisor compare: summary validation failed, using deterministic summary');
    return buildDeterministicSummary(products, evidence).text;
  }

  /**
   * LLM call with provider-failure mapping (see ADR 0026). Provider outages,
   * expired keys and timeouts become uniform 503 (429 when the provider
   * itself rate-limits) so clients can tell "try again later" apart from a
   * real 500. Only metadata reaches the logs — never prompts or keys.
   */
  private async generateSummary(system: string, userMessage: string): Promise<string> {
    try {
      return (
        await this.llm.generate({ system, messages: [{ role: 'user', content: userMessage }] })
      ).text;
    } catch (error) {
      if (error instanceof AiRateLimitError) {
        this.logger.warn(`advisor compare: provider rate limited provider=${error.provider}`);
        throw new HttpException(
          { message: 'Advisor provider rate limited, try again later' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (error instanceof AiProviderError) {
        this.logger.warn(
          `advisor compare: provider failed code=${error.code} provider=${error.provider}`,
        );
        throw new ServiceUnavailableException({
          message: 'Advisor provider unavailable, try again later',
        });
      }
      throw error;
    }
  }
}

/**
 * Deterministic fallback summary listing the compared products with their
 * SQL price and key specs plus the engine verdict — no LLM redaction
 * involved. Product evidence markers (`[n]`) resolve against the delivered
 * chunks via `buildCitations`. Pure except for the locale branch.
 */
export function buildDeterministicSummary(
  products: readonly ComparableProduct[],
  evidence: readonly RetrievalHit[],
  locale = 'en',
): { text: string; citations: ProductQaCitationDto[] } {
  const spanish = locale.toLowerCase().startsWith('es');
  const lines = products.map((product, index) => {
    const specs = Object.entries(product.specs)
      .slice(0, 4)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(' · ');
    const detail = specs.length > 0 ? ` (${specs})` : '';
    const marker = markerFor(product.id, evidence);
    return `${String(index + 1)}. ${product.name}${detail}${marker}`;
  });
  const text = spanish
    ? `Comparativa de ${String(products.length)} productos de la tienda:\n${lines.join('\n')}`
    : `Comparing ${String(products.length)} store products:\n${lines.join('\n')}`;
  return { text, citations: buildCitations(text, [...evidence]) };
}

function markerFor(productId: string, evidence: readonly RetrievalHit[]): string {
  const index = evidence.findIndex((hit) => hit.productId === productId);
  return index === -1 ? '' : ` [${String(index + 1)}]`;
}

/** Re-exported for unit tests asserting the table contract in isolation. */
export type { ComparableProduct as CompareProduct, ComparisonRow as CompareRow };
