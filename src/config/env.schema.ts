import { z } from 'zod';

const ISO_CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function isoCurrencyCode(field: string) {
  return z
    .string({ error: `${field} is required (3-letter ISO 4217 code, e.g. USD)` })
    .regex(ISO_CURRENCY_CODE_PATTERN, {
      error: `${field} must be a 3-letter ISO 4217 code (e.g. USD)`,
    });
}

const supportedCurrenciesSchema = z.preprocess(
  (value) =>
    value === undefined || value === null
      ? []
      : typeof value === 'string'
        ? value
            .split(',')
            .map((code) => code.trim().toUpperCase())
            .filter((code) => code.length > 0)
        : value,
  z
    .array(
      z.string().regex(ISO_CURRENCY_CODE_PATTERN, {
        error: 'each entry must be a 3-letter ISO 4217 code (e.g. USD,EUR)',
      }),
    )
    .min(1, { error: 'must list at least one currency (e.g. USD,EUR)' }),
);

const supportedLocalesSchema = z.preprocess(
  (value) =>
    value === undefined || value === null
      ? []
      : typeof value === 'string'
        ? value
            .split(',')
            .map((locale) => locale.trim())
            .filter((locale) => locale.length > 0)
        : value,
  z
    .array(
      z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, {
        error: 'each entry must be a BCP 47 locale (e.g. en,es)',
      }),
    )
    .min(1, { error: 'must list at least one locale (e.g. en,es)' }),
);

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * Test-mode-only secret key. Live keys (`sk_live_...`) are rejected on
 * purpose: this codebase must never run against live Stripe (ADR 0012).
 * Optional so local development and CI work without a Stripe account;
 * the payments module returns 503 while it is unset.
 */
const stripeSecretKeySchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .startsWith('sk_test_', { error: 'STRIPE_SECRET_KEY must be a test-mode key (sk_test_...)' })
    .optional(),
);

const stripePublishableKeySchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .startsWith('pk_test_', {
      error: 'STRIPE_PUBLISHABLE_KEY must be a test-mode key (pk_test_...)',
    })
    .optional(),
);

const stripeWebhookSecretSchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .min(8, { error: 'STRIPE_WEBHOOK_SECRET must be at least 8 characters long' })
    .optional(),
);

const stripeBaseUrlSchema = z.preprocess(
  emptyToUndefined,
  z
    .url({ error: 'STRIPE_BASE_URL must be a valid URL (e.g. http://localhost:12111)' })
    .refine((url) => url.startsWith('http://') || url.startsWith('https://'), {
      error: 'STRIPE_BASE_URL must use the http:// or https:// scheme',
    })
    .optional(),
);

const embeddingBaseUrlSchema = z.preprocess(
  emptyToUndefined,
  z
    .url({ error: 'EMBEDDING_BASE_URL must be a valid URL (e.g. https://api.openai.com/v1)' })
    .refine((url) => url.startsWith('http://') || url.startsWith('https://'), {
      error: 'EMBEDDING_BASE_URL must use the http:// or https:// scheme',
    })
    .optional(),
);

const embeddingModelSchema = z.preprocess(
  emptyToUndefined,
  z.string().min(1, { error: 'EMBEDDING_MODEL must be a non-empty model id' }).optional(),
);

const embeddingApiKeySchema = z.preprocess(
  emptyToUndefined,
  z.string().min(1, { error: 'EMBEDDING_API_KEY must be a non-empty key' }).optional(),
);

const llmBaseUrlSchema = z.preprocess(
  emptyToUndefined,
  z
    .url({ error: 'LLM_BASE_URL must be a valid URL (e.g. https://api.openai.com/v1)' })
    .refine((url) => url.startsWith('http://') || url.startsWith('https://'), {
      error: 'LLM_BASE_URL must use the http:// or https:// scheme',
    })
    .optional(),
);

const llmModelSchema = z.preprocess(
  emptyToUndefined,
  z.string().min(1, { error: 'LLM_MODEL must be a non-empty model id' }).optional(),
);

const llmApiKeySchema = z.preprocess(
  emptyToUndefined,
  z.string().min(1, { error: 'LLM_API_KEY must be a non-empty key' }).optional(),
);

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: z
      .url({
        error:
          'DATABASE_URL is required (e.g. postgresql://techadvisor:techadvisor@localhost:5432/techadvisor?schema=public)',
      })
      .refine((url) => url.startsWith('postgresql://') || url.startsWith('postgres://'), {
        error: 'DATABASE_URL must use the postgresql:// (or postgres://) scheme',
      }),
    REDIS_URL: z.url({ error: 'REDIS_URL is required (e.g. redis://localhost:6379)' }),
    JWT_SECRET: z
      .string({ error: 'JWT_SECRET is required (generate a long random secret, never commit it)' })
      .min(16, { error: 'JWT_SECRET must be at least 16 characters long' }),
    JWT_ACCESS_EXPIRES_IN_SEC: z.coerce.number().int().positive().default(900),
    JWT_REFRESH_EXPIRES_IN_SEC: z.coerce.number().int().positive().default(2592000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    AUTH_RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60000),
    // Public semantic search: looser than auth (read-only, but every hit
    // costs an embedding call + hybrid SQL, see ADR 0022).
    SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    SEARCH_RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60000),
    // Product-QA advisor: every hit costs retrieval (two hybrid searches)
    // plus one LLM call, so the default sits below search (see ADR 0025).
    ADVISOR_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
    ADVISOR_RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60000),
    // Minimum fused RRF score of the best evidence chunk to call the LLM.
    // RRF scores live on a small scale (one branch, rank 1, k=60 scores
    // 1/61 ≈ 0.0164; both branches at rank 1 score ≈ 0.0328), so the default
    // 0.016 answers when at least one modality ranks evidence first and
    // abstains otherwise (see ADR 0025).
    ADVISOR_ABSTAIN_MIN_SCORE: z.coerce.number().min(0).max(10).default(0.016),
    // Chat-session history bounds (see ADR 0029). The per-message cap is
    // enforced at the API edge in `ChatSessionsService` (the zod body schema
    // only requires non-empty content so the limit stays configurable without
    // code changes); the per-session cap bounds history growth and LLM
    // context cost in later phases. Anonymous sessions older than the
    // retention window are purged by the cleanup job.
    ADVISOR_SESSION_MAX_MESSAGES: z.coerce.number().int().min(1).max(10000).default(100),
    ADVISOR_MESSAGE_MAX_LENGTH: z.coerce.number().int().min(1).max(20000).default(2000),
    ADVISOR_ANON_SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    BASE_CURRENCY: isoCurrencyCode('BASE_CURRENCY'),
    SUPPORTED_CURRENCIES: supportedCurrenciesSchema,
    DEFAULT_LOCALE: z
      .string({ error: 'DEFAULT_LOCALE is required (BCP 47, e.g. en)' })
      .min(2, { error: 'DEFAULT_LOCALE must be a valid locale (e.g. en, es)' })
      .max(10)
      .default('en'),
    SUPPORTED_LOCALES: supportedLocalesSchema.default(['en', 'es']),
    DOCS_ENABLED: z
      .preprocess(
        (value) =>
          typeof value === 'string'
            ? value.trim().toLowerCase() === 'true' || value.trim() === '1'
            : value,
        z.boolean(),
      )
      .default(true),
    REQUEST_LOGGING_ENABLED: z
      .preprocess(
        (value) =>
          typeof value === 'string'
            ? value.trim().toLowerCase() === 'true' || value.trim() === '1'
            : value,
        z.boolean(),
      )
      .default(true),
    STRIPE_SECRET_KEY: stripeSecretKeySchema,
    STRIPE_PUBLISHABLE_KEY: stripePublishableKeySchema,
    STRIPE_WEBHOOK_SECRET: stripeWebhookSecretSchema,
    STRIPE_BASE_URL: stripeBaseUrlSchema,
    EMBEDDING_PROVIDER: z
      .enum(['fake', 'openai-compatible', 'nvidia'], {
        error: 'EMBEDDING_PROVIDER must be one of: fake, openai-compatible, nvidia',
      })
      .default('fake'),
    EMBEDDING_MODEL: embeddingModelSchema,
    EMBEDDING_API_KEY: embeddingApiKeySchema,
    EMBEDDING_BASE_URL: embeddingBaseUrlSchema,
    // pgvector indexed caps: 2.000 dims for `vector`, 4.000 for `halfvec`
    // (AGENTS.md §7, ADRs 0017/0018). Larger provider outputs must use
    // server-side reduction (or halfvec storage) first. The value must always
    // equal the indexed column width of the configured model.
    EMBEDDING_DIM: z.coerce.number().int().min(1).max(4000).default(1536),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(2048).default(100),
    EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
    EMBEDDING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
    EMBEDDING_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(500),
    EMBEDDING_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(100).max(300000).default(8000),
    LLM_PROVIDER: z
      .enum(['fake', 'openai-compatible', 'openai-responses', 'anthropic'], {
        error: 'LLM_PROVIDER must be one of: fake, openai-compatible, openai-responses, anthropic',
      })
      .default('fake'),
    LLM_MODEL: llmModelSchema,
    LLM_API_KEY: llmApiKeySchema,
    // Required for `openai-compatible` and `openai-responses`; optional
    // override for `anthropic` (the SDK defaults to
    // https://api.anthropic.com) and unused for `fake`...
    LLM_BASE_URL: llmBaseUrlSchema,
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
    LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    LLM_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(500),
    LLM_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(100).max(300000).default(8000),
    LLM_MAX_TOKENS: z.coerce.number().int().min(1).max(128000).default(1024),
    // Reasoning effort for thinking models via `openai-responses`
    // (minimal|low|medium|high). Sent as `reasoning.effort` only when set;
    // unset keeps the provider default. Non-reasoning models reject the
    // parameter, so leave it empty unless the model thinks.
    LLM_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    // Ingestion queue (BullMQ, see ADR 0019). Attempts bound the retries of
    // one job with exponential backoff starting at INGESTION_BACKOFF_MS;
    // INGESTION_CONCURRENCY sizes the standalone worker only.
    INGESTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    INGESTION_BACKOFF_MS: z.coerce.number().int().min(100).max(300000).default(5000),
    INGESTION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    // Admin document uploads (local disk, see ADR 0020). The max is capped
    // at 10 MiB because document bytes travel inside the BullMQ job payload
    // (`MAX_JOB_BYTES` in ingestion.constants.ts) — a larger file could
    // never be queued, so it is rejected at the edge instead.
    DOCUMENTS_DIR: z.string().min(1).default('./storage/documents'),
    DOCUMENTS_DRIVER: z
      .enum(['local', 'supabase'], {
        error: 'DOCUMENTS_DRIVER must be one of: local, supabase',
      })
      .default('local'),
    // Supabase Storage backend for admin-uploaded sources (see ADR 0071).
    // Only used when DOCUMENTS_DRIVER=supabase (production). The service
    // role key never leaves the server; the bucket stays private.
    SUPABASE_URL: z.preprocess(
      emptyToUndefined,
      z
        .url({ error: 'SUPABASE_URL must be a valid URL (e.g. https://xyz.supabase.co)' })
        .optional(),
    ),
    SUPABASE_SERVICE_ROLE_KEY: z.preprocess(
      emptyToUndefined,
      z.string().min(1, { error: 'SUPABASE_SERVICE_ROLE_KEY must be a non-empty key' }).optional(),
    ),
    SUPABASE_STORAGE_BUCKET: z.string().min(1).max(63).default('documents'),
    SUPABASE_STORAGE_PREFIX: z.string().max(256).default('storage/documents'),
    DOCUMENTS_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(10 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    // Review pros/cons summaries (see ADR 0037). The summary row is absent
    // while a product has fewer PUBLISHED reviews than this minimum; every
    // moderation change touching PUBLISHED re-runs the refresh inline.
    REVIEW_SUMMARY_MIN_REVIEWS: z.coerce.number().int().min(1).max(20).default(3),
    // Published reviews ingested per product into one REVIEW document (cap
    // bounds the prompt/queue payload; newest first).
    REVIEW_INGESTION_MAX_REVIEWS: z.coerce.number().int().min(1).max(100).default(20),
    // AI observability (see ADR 0039): retention of the metadata-only
    // `ai_call_logs` rows (purged by the admin cleanup trigger) and optional
    // per-1k-token USD tariffs used ONLY for the telemetry `estimated_cost`
    // column (never billing). Zero (default) means "no tariff configured" and
    // stores NULL cost.
    AI_CALL_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    AI_COST_LLM_INPUT_PER_1K: z.coerce.number().min(0).max(1000).default(0),
    AI_COST_LLM_OUTPUT_PER_1K: z.coerce.number().min(0).max(1000).default(0),
    AI_COST_EMBEDDING_PER_1K: z.coerce.number().min(0).max(1000).default(0),
  })
  .refine((env) => env.SUPPORTED_CURRENCIES.includes(env.BASE_CURRENCY), {
    error: 'BASE_CURRENCY must be listed in SUPPORTED_CURRENCIES',
    path: ['BASE_CURRENCY'],
  })
  .refine((env) => env.SUPPORTED_LOCALES.includes(env.DEFAULT_LOCALE), {
    error: 'DEFAULT_LOCALE must be listed in SUPPORTED_LOCALES',
    path: ['DEFAULT_LOCALE'],
  })
  .refine(
    (env) =>
      env.EMBEDDING_PROVIDER === 'fake' ||
      (env.EMBEDDING_BASE_URL !== undefined && env.EMBEDDING_MODEL !== undefined),
    {
      error:
        'EMBEDDING_BASE_URL and EMBEDDING_MODEL are required when EMBEDDING_PROVIDER is openai-compatible or nvidia',
      path: ['EMBEDDING_BASE_URL'],
    },
  )
  .refine((env) => env.LLM_PROVIDER === 'fake' || env.LLM_MODEL !== undefined, {
    error:
      'LLM_MODEL is required when LLM_PROVIDER is openai-compatible, openai-responses or anthropic',
    path: ['LLM_MODEL'],
  })
  .refine(
    (env) =>
      env.LLM_PROVIDER === 'fake' ||
      env.LLM_PROVIDER === 'anthropic' ||
      env.LLM_BASE_URL !== undefined,
    {
      error: 'LLM_BASE_URL is required when LLM_PROVIDER is openai-compatible or openai-responses',
      path: ['LLM_BASE_URL'],
    },
  )
  .refine(
    (env) =>
      env.DOCUMENTS_DRIVER === 'local' ||
      (env.SUPABASE_URL !== undefined && env.SUPABASE_SERVICE_ROLE_KEY !== undefined),
    {
      error:
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when DOCUMENTS_DRIVER is supabase',
      path: ['SUPABASE_URL'],
    },
  );

export type AppConfig = z.output<typeof envSchema>;

/**
 * Validates raw environment variables against the schema.
 * Throws a single legible Error listing every problem — the API must call
 * this at boot (and the NestJS config provider does) so misconfiguration
 * fails fast instead of surfacing as obscure runtime errors.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(result.error)}\nFix the variables above (see backend/.env.example) and restart.`,
    );
  }
  return result.data;
}
