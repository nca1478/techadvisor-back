import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AiProviderError } from '../ai/ai-provider.error.js';
import { pickLocalizedText, resolveLocale, resolvePrice } from '../catalog/catalog.service.js';
import { getSpecsFields } from '../catalog/specs/index.js';
import { toAvailability } from '../inventory/inventory.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type { CatalogCategoryDto, ProductListItemDto } from '../catalog/dto/catalog.dto.js';
import { RetrievalService, type RetrievalHit } from '../retrieval/retrieval.service.js';
import type { SearchQuery } from './search-query.schema.js';
import type { SearchResponseDto, SearchResultDto } from './dto/search.dto.js';

/** Chunks pulled from retrieval before grouping (several chunks map to one product). */
const RETRIEVAL_TOP_N = 30;
/** Evidence fragment length: enough context for a card, bounded for the payload. */
const SNIPPET_MAX_LENGTH = 280;
/**
 * Base score for SQL lexical matches (name/brand/SKU/description). It sits
 * far above any RRF score (consensus of both branches is ~0.03), so exact
 * catalog matches always outrank pure semantic neighbours. Products with
 * both add their RRF score on top, keeping chunk evidence first on ties.
 */
const LEXICAL_MATCH_SCORE = 1;

type SearchProductRow = Prisma.ProductGetPayload<{
  include: {
    brand: true;
    category: { include: { parent: { select: { slug: true } }; translations: true } };
    images: true;
    prices: true;
    translations: true;
  };
}>;

/**
 * Natural-language catalog search (see ADRs 0022 and 0042).
 *
 * Flow: hybrid retrieval (`RetrievalService`) + SQL lexical matches
 * (name/brand/SKU/description, case-insensitive) → hydrate every product
 * from SQL (price, availability, primary image — never from chunks) →
 * post-filter by category slug / resolved max price → order by score. When
 * lexical matches exist they win: pure vector neighbours without textual
 * support are dropped, so brand/name queries (e.g. "Kingston") never return
 * unrelated products just because their chunks are the closest vectors.
 * With no lexical match the ranking stays purely semantic. When the
 * embedding provider fails, the service degrades to full-text-only
 * retrieval and reports `degraded: true` instead of failing the request.
 * No LLM is involved.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async search(query: SearchQuery): Promise<SearchResponseDto> {
    const currency = this.requestedCurrency(query.currency);
    const locale = resolveLocale(
      query.locale,
      this.config.SUPPORTED_LOCALES,
      this.config.DEFAULT_LOCALE,
    );

    const { hits, degraded } = await this.retrieve(query.q, locale);
    const grouped = groupByProduct(hits);
    const lexicalRows = await this.findLexicalMatches(query.q, locale, currency, query.limit);
    if (grouped.size === 0 && lexicalRows.length === 0) {
      return { query: query.q, degraded, locale, currency, results: [] };
    }

    const lexicalIds = new Set(lexicalRows.map((row) => row.id));
    // With lexical matches, pure semantic neighbours are dropped below, so
    // their hydration is skipped entirely (one query saved per search).
    const ragOnlyIds =
      lexicalRows.length > 0 ? [] : [...grouped.keys()].filter((id) => !lexicalIds.has(id));
    const ragRows =
      ragOnlyIds.length > 0
        ? await this.prisma.product.findMany({
            where: { id: { in: ragOnlyIds }, status: 'ACTIVE' },
            include: this.productInclude(locale, currency),
          })
        : [];
    const rows: SearchProductRow[] = [...lexicalRows, ...ragRows];

    const availability = await this.inventory.getAvailabilityMap(rows.map((row) => row.id));

    const results: SearchResultDto[] = [];
    for (const row of rows) {
      const evidence = grouped.get(row.id);
      const isLexical = lexicalIds.has(row.id);
      if (evidence === undefined && !isLexical) {
        continue;
      }
      const price = resolvePrice(
        { amount: row.priceAmount, currency: row.currency },
        row.prices,
        currency,
      );
      // Price filter applies to the resolved price in the requested
      // currency (base row or fixed override, ADR 0007).
      if (query.maxPrice !== undefined && price.amount > query.maxPrice) {
        continue;
      }
      if (query.category !== undefined && row.category.slug !== query.category) {
        continue;
      }
      if (isLexical) {
        // Catalog match wins over semantic neighbours: base score above any
        // RRF value, plus the chunk score when the product has both, so
        // cited evidence keeps ranking first. Snippet prefers the chunk
        // fragment (citable) and falls back to the SQL description.
        results.push({
          product: this.toListItem(
            row,
            locale,
            currency,
            toAvailability(availability.get(row.id) ?? 0),
          ),
          score: LEXICAL_MATCH_SCORE + (evidence?.score ?? 0),
          snippet:
            evidence !== undefined
              ? toSnippet(evidence.content)
              : toSnippet(row.description.trim() === '' ? row.name : row.description),
        });
        continue;
      }
      if (evidence === undefined) {
        continue;
      }
      results.push({
        product: this.toListItem(
          row,
          locale,
          currency,
          toAvailability(availability.get(row.id) ?? 0),
        ),
        score: evidence.score,
        snippet: toSnippet(evidence.content),
      });
    }

    if (lexicalIds.size > 0) {
      // Lexical matches exist: drop pure semantic neighbours (they have no
      // textual support for this query) and order matches deterministically.
      const lexicalResults = results.filter((result) => lexicalIds.has(result.product.id));
      lexicalResults.sort(
        (left, right) =>
          right.score - left.score || left.product.name.localeCompare(right.product.name),
      );
      this.logger.debug(
        `search: hits=${String(hits.length)} products=${String(lexicalResults.length)} degraded=${String(degraded)} lexical=${String(lexicalIds.size)}`,
      );
      return {
        query: query.q,
        degraded,
        locale,
        currency,
        results: lexicalResults.slice(0, query.limit),
      };
    }

    results.sort((left, right) => right.score - left.score);

    // Never log the query text: it may contain personal data.
    this.logger.debug(
      `search: hits=${String(hits.length)} products=${String(results.length)} degraded=${String(degraded)}`,
    );

    return { query: query.q, degraded, locale, currency, results: results.slice(0, query.limit) };
  }

  /**
   * Hybrid retrieval first; on any provider failure (auth, rate limit,
   * timeout, network, server, config) fall back to full-text-only over the
   * same corpus and hard filters. The corpus scope is identical — only the
   * vector branch is skipped.
   */
  private async retrieve(
    query: string,
    locale: string,
  ): Promise<{ hits: RetrievalHit[]; degraded: boolean }> {
    const input = { query, locale, topN: RETRIEVAL_TOP_N };
    try {
      return { hits: await this.retrieval.search(input), degraded: false };
    } catch (error) {
      if (!(error instanceof AiProviderError)) {
        throw error;
      }
      this.logger.warn(`search: embedding provider failed (${error.code}), degrading to full-text`);
      return { hits: await this.retrieval.searchFulltextOnly(input), degraded: true };
    }
  }

  /** Shared hydration shape: price, availability and image always come from SQL. */
  private productInclude(locale: string, currency: string) {
    return {
      brand: true,
      category: {
        include: {
          parent: { select: { slug: true } },
          translations: { where: { locale } },
        },
      },
      images: { orderBy: { position: 'asc' } },
      prices: { where: { currency } },
      translations: { where: { locale } },
    } as const;
  }

  /**
   * Case-insensitive catalog matches over product name, description, SKU,
   * brand (name/slug) and translated name/description. Fully parameterized
   * via Prisma (`contains`, no raw SQL), ACTIVE products only, deterministic
   * name order, capped at `limit`. These matches rescue products that have
   * no chunks indexed yet (see ADR 0022: the RAG corpus only "sees" products
   * with READY chunks) and outrank pure vector neighbours.
   */
  private async findLexicalMatches(
    q: string,
    locale: string,
    currency: string,
    limit: number,
  ): Promise<SearchProductRow[]> {
    return this.prisma.product.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { brand: { name: { contains: q, mode: 'insensitive' } } },
          { brand: { slug: { contains: q, mode: 'insensitive' } } },
          { translations: { some: { name: { contains: q, mode: 'insensitive' } } } },
          { translations: { some: { description: { contains: q, mode: 'insensitive' } } } },
        ],
      },
      include: this.productInclude(locale, currency),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  private requestedCurrency(currency: string | undefined): string {
    const requested = currency ?? this.config.BASE_CURRENCY;
    if (!this.config.SUPPORTED_CURRENCIES.includes(requested)) {
      throw new BadRequestException({
        message: `Unsupported currency "${requested}". Supported: ${this.config.SUPPORTED_CURRENCIES.join(', ')}`,
      });
    }
    return requested;
  }

  private toListItem(
    row: SearchProductRow,
    locale: string,
    currency: string,
    availability: { inStock: boolean; availableQuantity: number },
  ): ProductListItemDto {
    const price = resolvePrice(
      { amount: row.priceAmount, currency: row.currency },
      row.prices,
      currency,
    );
    const primary = row.images.length > 0 ? row.images[0] : null;
    return {
      id: row.id,
      sku: row.sku,
      name: pickLocalizedText(
        row.translations,
        locale,
        (translation) => translation.name,
        row.name,
      ),
      slug: row.slug,
      description: pickLocalizedText(
        row.translations,
        locale,
        (translation) => translation.description,
        row.description,
      ),
      brand: { id: row.brand.id, name: row.brand.name, slug: row.brand.slug },
      category: this.toCategory(row.category, locale),
      priceAmount: price.amount,
      currency: price.currency,
      specs: (row.specs ?? {}) as Record<string, unknown>,
      inStock: availability.inStock,
      availableQuantity: availability.availableQuantity,
      imageUrl: primary?.url ?? null,
      // When the image has no alt, clients fall back to the product name.
      imageAlt: primary?.alt ?? null,
      locale,
      createdAt: row.createdAt,
    };
  }

  private toCategory(row: SearchProductRow['category'], locale: string): CatalogCategoryDto {
    return {
      id: row.id,
      name: pickLocalizedText(
        row.translations,
        locale,
        (translation) => translation.name,
        row.name,
      ),
      slug: row.slug,
      parentSlug: row.parent?.slug ?? null,
      specsSchema: getSpecsFields(row.slug).map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        ...(field.unit !== undefined ? { unit: field.unit } : {}),
        ...(field.options !== undefined ? { options: [...field.options] } : {}),
      })),
      locale,
    };
  }
}

interface ProductEvidence {
  score: number;
  content: string;
}

/**
 * Groups retrieval hits by product, keeping the best (highest-score) chunk
 * as the evidence for each product. Hits without a product (category or
 * policy documents) cannot back a product card and are skipped.
 */
export function groupByProduct(hits: RetrievalHit[]): Map<string, ProductEvidence> {
  const grouped = new Map<string, ProductEvidence>();
  for (const hit of hits) {
    if (hit.productId === null) {
      continue;
    }
    const current = grouped.get(hit.productId);
    if (current === undefined || hit.score > current.score) {
      grouped.set(hit.productId, { score: hit.score, content: hit.content });
    }
  }
  return grouped;
}

/** Collapses whitespace and truncates the evidence fragment to a fixed length. */
export function toSnippet(content: string, maxLength: number = SNIPPET_MAX_LENGTH): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength).trimEnd()}…`;
}

export { LEXICAL_MATCH_SCORE, RETRIEVAL_TOP_N, SNIPPET_MAX_LENGTH };
