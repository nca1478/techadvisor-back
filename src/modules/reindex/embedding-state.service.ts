import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { createEmbeddingProvider } from '../ai/ai-provider.factory.js';
import type {
  EmbedOptions,
  EmbeddingProvider,
} from '../ai/interfaces/embedding-provider.interface.js';
import { assertEmbeddingColumnIdentifier, resolveEmbeddingColumnRef } from './embedding-columns.js';
import { ACTIVE_EMBEDDING_KEY, FALLBACK_FAKE_MODEL } from './reindex.constants.js';

/**
 * Retrieval scope served by the ACTIVE embedding model: which model tag the
 * SQL filters on, which physical column the vector branch orders by, and a
 * provider able to embed the incoming query with that same model.
 *
 * Query and column models must always match (comparing vectors across models
 * is meaningless); the scope bundles them so callers cannot mix them up.
 */
export interface ActiveEmbeddingScope {
  model: string;
  dimensions: number;
  column: string;
  cast: 'vector' | 'halfvec';
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}

/**
 * Persisted "active model" pointer (see ADR 0023).
 *
 * Retrieval (`RetrievalService`) never reads `EMBEDDING_*` directly for
 * model selection: it asks this service, so a background reindex toward a
 * new model never disturbs live search until an explicit activation flips
 * the single `rag_embedding_state` row. The row is lazy-seeded from env on
 * first use, so fresh databases behave exactly like the env-configured
 * model with no manual step.
 */
@Injectable()
export class EmbeddingStateService {
  private readonly logger = new Logger(EmbeddingStateService.name);
  private readonly providerCache = new Map<string, EmbeddingProvider>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Model id configured for the embedding backend (target of a switch). */
  configuredModel(): string {
    const model = this.config.EMBEDDING_MODEL;
    return model === undefined || model.length === 0 ? FALLBACK_FAKE_MODEL : model;
  }

  /** Active `{ model, dim, column, cast }`, seeded from env when absent. */
  async getActive(): Promise<{ model: string; dim: number; column: string; cast: string }> {
    const row = await this.prisma.ragEmbeddingState.findUnique({
      where: { key: ACTIVE_EMBEDDING_KEY },
    });
    if (row !== null) {
      assertEmbeddingColumnIdentifier(row.column);
      return { model: row.model, dim: row.dim, column: row.column, cast: row.cast };
    }
    return this.seedFromEnv();
  }

  /**
   * Full retrieval scope for the active model, including a provider that
   * embeds queries with it. Providers are built from the current env
   * credentials plus the active model/dim and cached per `model:dim` — the
   * same endpoint generally serves both the old and the new model id during
   * a switch (see ADR 0023 §provider moves).
   */
  async getScope(): Promise<ActiveEmbeddingScope> {
    const active = await this.getActive();
    const provider = this.providerFor(active.model, active.dim);
    return {
      model: active.model,
      dimensions: active.dim,
      column: active.column,
      cast: active.cast === 'halfvec' ? 'halfvec' : 'vector',
      embed: (texts, opts) => provider.embed(texts, opts),
    };
  }

  /**
   * Builds (and caches) the provider for an explicit model/dim pair. Used
   * for the active scope above and by the reindex batches for the target
   * model — always the same backend/credentials, only the model id and width
   * change, which is precisely the provider-agnostic switch (ADR 0016).
   */
  providerFor(model: string, dimensions: number): EmbeddingProvider {
    const cacheKey = `${model}:${String(dimensions)}`;
    const cached = this.providerCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const provider = createEmbeddingProvider({
      ...this.config,
      EMBEDDING_MODEL: model,
      EMBEDDING_DIM: dimensions,
    });
    this.providerCache.set(cacheKey, provider);
    return provider;
  }

  private async seedFromEnv(): Promise<{
    model: string;
    dim: number;
    column: string;
    cast: string;
  }> {
    const model = this.configuredModel();
    const dim = this.config.EMBEDDING_DIM;
    const { column, cast } = resolveEmbeddingColumnRef(dim);
    const row = await this.prisma.ragEmbeddingState.upsert({
      where: { key: ACTIVE_EMBEDDING_KEY },
      create: { key: ACTIVE_EMBEDDING_KEY, model, dim, column, cast },
      update: {},
    });
    this.logger.log(`Seeded active embedding model ${model} (${String(dim)}d → ${column})`);
    return { model: row.model, dim: row.dim, column: row.column, cast: row.cast };
  }
}
