/**
 * Single source of truth mapping embedding widths to their pgvector columns
 * (see ADR 0023). Every module that touches a vector column — ingestion
 * (writes), retrieval (reads), reindex (both) — resolves through this file,
 * so a new model width means one registry entry plus its additive migration,
 * never scattered `if (dim === …)` branches.
 *
 * Columns are owned ENTIRELY by raw SQL migrations (Prisma has no vector
 * type): `embedding vector(1536)` (default model, ADR 0017),
 * `embedding_halfvec halfvec(2048)` (NVIDIA, ADR 0018) and `embedding_v2`
 * (landing column for the next model width, ADR 0023). The old column is
 * never dropped in the same task that introduces the new one.
 */

export interface EmbeddingColumnRef {
  /** Physical column in `chunks` holding the vectors of this width. */
  column: string;
  /** pgvector type used when casting query literals (`::vector`, `::halfvec`). */
  cast: 'vector' | 'halfvec';
}

export class EmbeddingColumnError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'EmbeddingColumnError';
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

const KNOWN_COLUMNS: Record<number, EmbeddingColumnRef> = {
  // Default model text-embedding-3-small, native 1536 dims (ADR 0017).
  1536: { column: 'embedding', cast: 'vector' },
  // NVIDIA nemotron-3-embed-1b, native 2048 dims stored as halfvec (ADR 0018).
  2048: { column: 'embedding_halfvec', cast: 'halfvec' },
  // Landing column for the next model width (ADR 0023): sized for the
  // reference switch target used by the offline reindex harness. A future
  // production width either reuses this slot (same `M`, no schema change) or
  // gets its own column + registry entry via a new additive migration.
  16: { column: 'embedding_v2', cast: 'vector' },
};

/**
 * Resolves the pgvector column for an embedding width. Unknown widths fail
 * loudly — they need their own column migration plus ADR entry (see
 * `embeddingColumnDdl` for the exact template), never silent mixing of
 * models or dimensions in one indexed column (AGENTS.md §5.3).
 */
export function resolveEmbeddingColumnRef(dimensions: number): EmbeddingColumnRef {
  if (!Object.hasOwn(KNOWN_COLUMNS, dimensions)) {
    throw new EmbeddingColumnError(
      `Unsupported embedding dimensions ${String(dimensions)} (known widths: ${Object.keys(KNOWN_COLUMNS).join(', ')}; a new width needs its own column migration, see ADR 0023)`,
    );
  }
  return KNOWN_COLUMNS[dimensions];
}

/**
 * Guards every dynamic column interpolation into `$queryRaw`/`$executeRaw`.
 * Identifiers cannot travel as bound parameters, so only lowercase
 * snake_case names from the registry (or the persisted active-model state,
 * which is itself written from the registry) ever reach `Prisma.raw`.
 */
const COLUMN_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertEmbeddingColumnIdentifier(name: string): void {
  if (!COLUMN_IDENTIFIER_PATTERN.test(name)) {
    throw new EmbeddingColumnError(
      `Refusing to interpolate suspicious embedding column name ${JSON.stringify(name)} into SQL`,
    );
  }
}

/**
 * Exact additive DDL template for provisioning the column of a new width.
 * Returned (not executed) by the reindex starter when the target column is
 * missing, so the operator applies it as a reviewed migration — columns are
 * never created implicitly at runtime.
 */
export function embeddingColumnDdl(
  column: string,
  dimensions: number,
  cast: 'vector' | 'halfvec',
): string {
  assertEmbeddingColumnIdentifier(column);
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4000) {
    throw new EmbeddingColumnError(
      `Refusing to render DDL for out-of-range dimensions ${String(dimensions)}`,
    );
  }
  const index = `chunks_${column}_hnsw_idx`;
  assertEmbeddingColumnIdentifier(index);
  const opclass = cast === 'halfvec' ? 'halfvec_cosine_ops' : 'vector_cosine_ops';
  return [
    `ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "${column}" ${cast}(${String(dimensions)});`,
    `CREATE INDEX IF NOT EXISTS "${index}" ON "chunks" USING hnsw ("${column}" ${opclass});`,
  ].join('\n');
}
