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
    // Ingestion queue (BullMQ, see ADR 0019). Attempts bound the retries of
    // one job with exponential backoff starting at INGESTION_BACKOFF_MS;
    // INGESTION_CONCURRENCY sizes the standalone worker only.
    INGESTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    INGESTION_BACKOFF_MS: z.coerce.number().int().min(100).max(300000).default(5000),
    INGESTION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
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
