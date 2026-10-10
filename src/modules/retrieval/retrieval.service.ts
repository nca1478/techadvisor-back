import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
  type EmbedOptions,
} from '../ai/interfaces/embedding-provider.interface.js';
import { assertEmbeddingColumnIdentifier } from '../reindex/embedding-columns.js';
import type { ActiveEmbeddingScope } from '../reindex/embedding-state.service.js';
import { EmbeddingStateService } from '../reindex/embedding-state.service.js';
import { fuseRankings } from './reciprocal-rank-fusion.js';
import { resolveEmbeddingColumnRef } from '../reindex/embedding-columns.js';
import {
  retrievalSearchSchema,
  type RetrievalSearch,
  type RetrievalSearchInput,
} from './retrieval.schemas.js';
import { hasSkuPattern } from './sku-pattern.js';
import { AiCallLoggerService } from '../observability/ai-call-logger.service.js';

/** Full-text configuration implied by a BCP 47 locale (mirrors SQL `rag_regconfig`). */
export type FulltextConfig = 'spanish' | 'english';

/** One retrieval hit: the chunk plus its fused score and provenance. */
export interface RetrievalHit {
  chunkId: string;
  documentId: string;
  productId: string | null;
  content: string;
  locale: string;
  score: number;
  source: { title: string; docType: string; sourceUrl: string | null };
}

export class RetrievalError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'RetrievalError';
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const DEFAULT_TOP_N = 8;
const DEFAULT_CANDIDATE_K = 20;
const DEFAULT_RRF_K = 60;
/** Full-text RRF weight doubles when the query carries an SKU/model token. */
const FULLTEXT_WEIGHT_SKU = 2;

/** Raw row shared by the vector and full-text candidate queries. */
interface CandidateRow {
  chunkId: string;
  documentId: string;
  productId: string | null;
  content: string;
  locale: string;
  docType: string;
  title: string;
  sourceUrl: string | null;
}

/**
 * Hybrid retrieval service (see ADR 0021): vector candidates (cosine) +
 * full-text candidates (`ts_rank`) fused with Reciprocal Rank Fusion.
 *
 * Every filter is a hard SQL condition applied before ranking; all values
 * travel as bound parameters via `Prisma.sql` composition — user input is
 * never interpolated into SQL text. Only `Prisma.raw` embeds identifiers,
 * and solely for the embedding column chosen from an internal allowlist.
 */
/**
 * Hybrid retrieval service (see ADR 0021): vector candidates (cosine) +
 * full-text candidates (`ts_rank`) fused with Reciprocal Rank Fusion.
 *
 * Every filter is a hard SQL condition applied before ranking; all values
 * travel as bound parameters via `Prisma.sql` composition — user input is
 * never interpolated into SQL text. Only `Prisma.raw` embeds identifiers,
 * and solely for the embedding column chosen from an internal allowlist.
 *
 * Model selection never reads env directly when the reindex module is
 * wired: the persisted ACTIVE model (`EmbeddingStateService`, ADR 0023)
 * decides which `embedding_model` tag and which physical column both
 * branches query, so a background reindex never disturbs live search until
 * an explicit activation. Without the state service (unit tests, legacy
 * wiring) the injected env-configured provider is used as before.
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Optional() private readonly state?: EmbeddingStateService | null,
    @Optional() private readonly callLogger?: AiCallLoggerService | null,
  ) {}

  async search(input: RetrievalSearchInput): Promise<RetrievalHit[]> {
    const startedAt = Date.now();
    try {
      const hits = await this.searchInner(input);
      this.callLogger?.log({
        type: 'RETRIEVAL',
        provider: 'local',
        model: 'hybrid-rrf-v1',
        latencyMs: Date.now() - startedAt,
        status: 'OK',
      });
      return hits;
    } catch (error) {
      this.callLogger?.log({
        type: 'RETRIEVAL',
        provider: 'local',
        model: 'hybrid-rrf-v1',
        latencyMs: Date.now() - startedAt,
        status: 'ERROR',
        errorCode: error instanceof Error ? error.name.slice(0, 120) : 'unknown',
      });
      throw error;
    }
  }

  private async searchInner(input: RetrievalSearchInput): Promise<RetrievalHit[]> {
    const { query, filters, locale, topN, candidateK, rrfK } = this.parseInput(input);
    const scope = await this.resolveScope();

    const vectors = await scope.embed([query], { kind: 'query' });
    const queryVector = vectors.at(0);
    if (queryVector === undefined) {
      throw new RetrievalError('Embedding provider returned no vector for the query');
    }

    // Both branches share the hard filters, including the active-model scope:
    // a query never touches chunks embedded with another model (or not
    // embedded yet) — see ADR 0021.
    const conditions = this.buildFilterConditions(filters, scope.model);
    const vectorCandidates = await this.vectorCandidates(
      queryVector,
      conditions,
      candidateK,
      scope.column,
      scope.cast,
    );
    const fulltextCandidates = await this.fulltextCandidates(
      query,
      filters.locales ?? [],
      locale,
      conditions,
      candidateK,
    );

    const byId = new Map<string, CandidateRow>();
    for (const row of [...vectorCandidates, ...fulltextCandidates]) {
      byId.set(row.chunkId, row);
    }
    const fulltextWeight = hasSkuPattern(query) ? FULLTEXT_WEIGHT_SKU : 1;
    const fused = fuseRankings(
      [vectorCandidates.map((row) => row.chunkId), fulltextCandidates.map((row) => row.chunkId)],
      { k: rrfK, weights: [1, fulltextWeight] },
    );

    // Never log the query text: it may contain personal data.
    this.logger.debug(
      `retrieval: vector=${String(vectorCandidates.length)} fulltext=${String(fulltextCandidates.length)} fused=${String(fused.length)} topN=${String(topN)}`,
    );

    return fused.slice(0, topN).map((entry) => {
      const row = byId.get(entry.id);
      if (row === undefined) {
        throw new RetrievalError(`Fused chunk ${entry.id} has no candidate row`);
      }
      return {
        chunkId: row.chunkId,
        documentId: row.documentId,
        productId: row.productId,
        content: row.content,
        locale: row.locale,
        score: entry.score,
        source: { title: row.title, docType: row.docType, sourceUrl: row.sourceUrl },
      };
    });
  }

  /**
   * Full-text-only search over the same corpus and hard filters, without
   * touching the embedding provider. Used as the degraded fallback when the
   * provider fails (see the `search` module): ranking comes from the
   * `ts_rank` order of each linguistic branch, scored on the same RRF scale
   * (`1 / (rrfK + rank)`) so scores stay comparable with hybrid results.
   */
  async searchFulltextOnly(input: RetrievalSearchInput): Promise<RetrievalHit[]> {
    const startedAt = Date.now();
    try {
      const hits = await this.searchFulltextOnlyInner(input);
      this.callLogger?.log({
        type: 'RETRIEVAL',
        provider: 'local',
        model: 'fulltext-only-v1',
        latencyMs: Date.now() - startedAt,
        status: 'OK',
      });
      return hits;
    } catch (error) {
      this.callLogger?.log({
        type: 'RETRIEVAL',
        provider: 'local',
        model: 'fulltext-only-v1',
        latencyMs: Date.now() - startedAt,
        status: 'ERROR',
        errorCode: error instanceof Error ? error.name.slice(0, 120) : 'unknown',
      });
      throw error;
    }
  }

  private async searchFulltextOnlyInner(input: RetrievalSearchInput): Promise<RetrievalHit[]> {
    const { query, filters, locale, topN, candidateK, rrfK } = this.parseInput(input);
    const scope = await this.resolveScope();

    const conditions = this.buildFilterConditions(filters, scope.model);
    const rows = await this.fulltextCandidates(
      query,
      filters.locales ?? [],
      locale,
      conditions,
      candidateK,
    );
    const byId = new Map<string, CandidateRow>();
    for (const row of rows) {
      byId.set(row.chunkId, row);
    }
    const fused = fuseRankings([rows.map((row) => row.chunkId)], { k: rrfK });

    // Never log the query text: it may contain personal data.
    this.logger.debug(
      `retrieval(fulltext-only): candidates=${String(rows.length)} topN=${String(topN)}`,
    );

    return fused.slice(0, topN).map((entry) => {
      const row = byId.get(entry.id);
      if (row === undefined) {
        throw new RetrievalError(`Fused chunk ${entry.id} has no candidate row`);
      }
      return {
        chunkId: row.chunkId,
        documentId: row.documentId,
        productId: row.productId,
        content: row.content,
        locale: row.locale,
        score: entry.score,
        source: { title: row.title, docType: row.docType, sourceUrl: row.sourceUrl },
      };
    });
  }

  /**
   * Which model/column/provider serves this query. With the reindex module
   * wired, the persisted ACTIVE model wins (its row is a single indexed PK
   * lookup per search — negligible next to the embedding call and the hybrid
   * SQL, and it can never go stale). Otherwise the env-configured provider
   * behaves exactly as before (unit tests, legacy wiring).
   */
  private async resolveScope(): Promise<
    Pick<ActiveEmbeddingScope, 'model' | 'column' | 'cast'> & {
      embed: (texts: string[], opts?: EmbedOptions) => Promise<number[][]>;
    }
  > {
    if (this.state !== undefined && this.state !== null) {
      return this.state.getScope();
    }
    const { column, cast } = resolveEmbeddingColumn(this.embeddings.dimensions);
    const provider = this.embeddings;
    return {
      model: provider.model,
      column,
      cast,
      embed: (texts, opts) => provider.embed(texts, opts),
    };
  }

  private parseInput(input: RetrievalSearchInput): RetrievalSearch {
    const parsed = retrievalSearchSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
      );
      throw new BadRequestException({ message: issues.join('; '), details: issues });
    }
    return parsed.data;
  }

  /**
   * Hard metadata filters shared by both branches, applied in SQL before any
   * ranking. Only chunks of READY, non-deleted documents are visible, only
   * chunks whose product is ACTIVE (chunks without a product — e.g. category
   * or policy documents — have no product to be inactive, so they stay
   * visible), and only chunks whose `embedding_model` is the active model:
   * embeddings of different models are never mixed in one query, and
   * not-yet-embedded chunks stay out of retrieval (raw `tsv` search remains
   * available for backfill inspection).
   */
  private buildFilterConditions(
    filters: {
      productId?: string;
      categoryId?: string;
      docTypes?: string[];
      locales?: string[];
    },
    embeddingModel: string,
  ): Prisma.Sql {
    const parts: Prisma.Sql[] = [
      Prisma.sql`d."status" = 'READY'`,
      Prisma.sql`d."deleted_at" IS NULL`,
      Prisma.sql`(c."product_id" IS NULL OR p."status" = 'ACTIVE')`,
      Prisma.sql`c."embedding_model" = ${embeddingModel}`,
    ];
    if (filters.productId !== undefined) {
      parts.push(
        Prisma.sql`(c."product_id" = ${filters.productId}::uuid OR d."product_id" = ${filters.productId}::uuid)`,
      );
    }
    if (filters.categoryId !== undefined) {
      parts.push(Prisma.sql`d."category_id" = ${filters.categoryId}::uuid`);
    }
    if (filters.docTypes !== undefined && filters.docTypes.length > 0) {
      parts.push(
        Prisma.sql`d."type" IN (${Prisma.join(filters.docTypes.map((type) => Prisma.sql`${type}::"DocumentType"`))})`,
      );
    }
    if (filters.locales !== undefined && filters.locales.length > 0) {
      parts.push(
        Prisma.sql`c."locale" IN (${Prisma.join(filters.locales.map((value) => Prisma.sql`${value}`))})`,
      );
    }
    return Prisma.join(parts, ' AND ');
  }

  private candidateSelect(): Prisma.Sql {
    return Prisma.sql`
      SELECT c."id" AS "chunkId", c."document_id" AS "documentId",
        c."product_id" AS "productId", c."content" AS "content",
        c."locale" AS "locale", d."type"::text AS "docType",
        d."title" AS "title", d."source_url" AS "sourceUrl"
      FROM "chunks" c
      JOIN "documents" d ON d."id" = c."document_id"
      LEFT JOIN "products" p ON p."id" = c."product_id"
    `;
  }

  /**
   * Vector candidates ordered by cosine distance. The shared conditions
   * already scope to the active `embedding_model`; the extra `IS NOT NULL`
   * keeps pre-embedding rows (model set, vector pending) out of the ordering.
   */
  private async vectorCandidates(
    queryVector: number[],
    conditions: Prisma.Sql,
    limit: number,
    column: string,
    cast: 'vector' | 'halfvec',
  ): Promise<CandidateRow[]> {
    assertEmbeddingColumnIdentifier(column);
    const literal = `[${queryVector.join(',')}]`;
    // Column/cast come from the active scope (registry or persisted state,
    // both allowlisted) — never user input.
    const columnRef = Prisma.raw(`c."${column}"`);
    const distance = Prisma.sql`${columnRef} <=> ${literal}::${Prisma.raw(cast)}`;
    return this.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      ${this.candidateSelect()}
      WHERE ${conditions}
        AND ${columnRef} IS NOT NULL
      ORDER BY ${distance}
      LIMIT ${limit}
    `);
  }

  /**
   * Full-text candidates per linguistic configuration. Each chunk's `tsv`
   * was built with its own locale config (trigger, ADR 0015), so the query
   * side must use the same config per chunk group: one branch query per
   * config in `resolveFulltextConfigs`, restricted with
   * `rag_regconfig(c.locale) = config`. The shared conditions scope to the
   * active `embedding_model`, so no foreign-model chunk can leak in through
   * the text branch either.
   */
  private async fulltextCandidates(
    query: string,
    filterLocales: string[],
    requestLocale: string | undefined,
    conditions: Prisma.Sql,
    limit: number,
  ): Promise<CandidateRow[]> {
    const configs = resolveFulltextConfigs(filterLocales, requestLocale);
    const rows: CandidateRow[] = [];
    for (const config of configs) {
      const matches = await this.prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
        ${this.candidateSelect()}
        WHERE ${conditions}
          AND rag_regconfig(c."locale") = ${config}::regconfig
          AND c."tsv" @@ plainto_tsquery(${config}::regconfig, ${query})
        ORDER BY ts_rank(c."tsv", plainto_tsquery(${config}::regconfig, ${query})) DESC
        LIMIT ${limit}
      `);
      rows.push(...matches);
    }
    return rows;
  }
}

/**
 * Selects the pgvector column matching the active embedding width.
 * Single source of truth lives in `modules/reindex/embedding-columns.ts`
 * (ADR 0023); this wrapper keeps the historical import path and the
 * `RetrievalError` type for read-path failures. Any other width fails loudly
 * — it needs its own column migration plus ADR, never silent mixing.
 * Returned fragments feed `Prisma.raw` only (identifiers cannot be bound
 * parameters).
 */
export function resolveEmbeddingColumn(dimensions: number): {
  column: string;
  cast: 'vector' | 'halfvec';
} {
  try {
    return resolveEmbeddingColumnRef(dimensions);
  } catch (error) {
    throw new RetrievalError(
      error instanceof Error
        ? error.message
        : `Unsupported embedding dimensions ${String(dimensions)}`,
      { cause: error },
    );
  }
}

/**
 * Which full-text configurations to query. The request `locale` and the
 * `locales` filter both narrow the set (mapped with the same rule as SQL
 * `rag_regconfig`: `es*` → spanish, anything else → english — mantener en
 * sync con la migración `..._add_chunk_tsv_fulltext`). With no locale
 * information, both configurations are queried so no language group is
 * silently skipped.
 */
export function resolveFulltextConfigs(
  filterLocales: string[],
  requestLocale: string | undefined,
): FulltextConfig[] {
  const inputs = [...filterLocales];
  if (requestLocale !== undefined) {
    inputs.push(requestLocale);
  }
  if (inputs.length === 0) {
    return ['spanish', 'english'];
  }
  const configs = new Set<FulltextConfig>();
  for (const locale of inputs) {
    configs.add(locale.toLowerCase().startsWith('es') ? 'spanish' : 'english');
  }
  return [...configs];
}

export { DEFAULT_TOP_N, DEFAULT_CANDIDATE_K, DEFAULT_RRF_K };
