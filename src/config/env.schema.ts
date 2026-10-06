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
  })
  .refine((env) => env.SUPPORTED_CURRENCIES.includes(env.BASE_CURRENCY), {
    error: 'BASE_CURRENCY must be listed in SUPPORTED_CURRENCIES',
    path: ['BASE_CURRENCY'],
  })
  .refine((env) => env.SUPPORTED_LOCALES.includes(env.DEFAULT_LOCALE), {
    error: 'DEFAULT_LOCALE must be listed in SUPPORTED_LOCALES',
    path: ['DEFAULT_LOCALE'],
  });

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
