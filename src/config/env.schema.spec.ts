import { parseEnv } from './env.schema.js';

const VALID_ENV: NodeJS.ProcessEnv = {
  PORT: '3001',
  DATABASE_URL: 'postgresql://techadvisor:techadvisor@localhost:5432/techadvisor?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'change-me-to-a-long-random-secret',
  CORS_ORIGINS: 'http://localhost:3000',
  BASE_CURRENCY: 'USD',
  SUPPORTED_CURRENCIES: 'USD,EUR',
  DEFAULT_LOCALE: 'en',
  SUPPORTED_LOCALES: 'en,es',
  DOCS_ENABLED: 'true',
};

describe('parseEnv', () => {
  it('accepts a complete valid environment', () => {
    const config = parseEnv({ ...VALID_ENV });

    expect(config.PORT).toBe(3001);
    expect(config.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(config.BASE_CURRENCY).toBe('USD');
    expect(config.SUPPORTED_CURRENCIES).toEqual(['USD', 'EUR']);
    expect(config.DEFAULT_LOCALE).toBe('en');
    expect(config.SUPPORTED_LOCALES).toEqual(['en', 'es']);
    expect(config.DOCS_ENABLED).toBe(true);
  });

  it('normalizes the currency list (trims, uppercases, drops empties)', () => {
    const config = parseEnv({ ...VALID_ENV, SUPPORTED_CURRENCIES: ' usd,, eur ' });

    expect(config.SUPPORTED_CURRENCIES).toEqual(['USD', 'EUR']);
    expect(config.BASE_CURRENCY).toBe('USD');
  });

  it('applies defaults for PORT and DEFAULT_LOCALE', () => {
    const config = parseEnv({ ...VALID_ENV, PORT: undefined, DEFAULT_LOCALE: undefined });

    expect(config.PORT).toBe(3001);
    expect(config.DEFAULT_LOCALE).toBe('en');
  });

  it('fails with a legible error when DATABASE_URL is missing', () => {
    expect(() => parseEnv({ ...VALID_ENV, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('fails when DATABASE_URL is not a postgres URL', () => {
    expect(() => parseEnv({ ...VALID_ENV, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('fails when BASE_CURRENCY is not a 3-letter code', () => {
    expect(() => parseEnv({ ...VALID_ENV, BASE_CURRENCY: 'dollar' })).toThrow(/BASE_CURRENCY/);
  });

  it('fails when BASE_CURRENCY is not listed in SUPPORTED_CURRENCIES', () => {
    expect(() => parseEnv({ ...VALID_ENV, BASE_CURRENCY: 'GBP' })).toThrow(
      /BASE_CURRENCY must be listed in SUPPORTED_CURRENCIES/,
    );
  });

  it('fails when DEFAULT_LOCALE is not listed in SUPPORTED_LOCALES', () => {
    expect(() => parseEnv({ ...VALID_ENV, DEFAULT_LOCALE: 'fr' })).toThrow(
      /DEFAULT_LOCALE must be listed in SUPPORTED_LOCALES/,
    );
  });

  it('parses DOCS_ENABLED as a boolean and defaults to true', () => {
    expect(parseEnv({ ...VALID_ENV, DOCS_ENABLED: 'false' }).DOCS_ENABLED).toBe(false);
    const withoutDocsFlag = { ...VALID_ENV };
    delete withoutDocsFlag.DOCS_ENABLED;
    expect(parseEnv(withoutDocsFlag).DOCS_ENABLED).toBe(true);
  });

  it('parses REQUEST_LOGGING_ENABLED as a boolean and defaults to true', () => {
    expect(
      parseEnv({ ...VALID_ENV, REQUEST_LOGGING_ENABLED: 'false' }).REQUEST_LOGGING_ENABLED,
    ).toBe(false);
    expect(parseEnv({ ...VALID_ENV, REQUEST_LOGGING_ENABLED: '0' }).REQUEST_LOGGING_ENABLED).toBe(
      false,
    );
    const withoutFlag = { ...VALID_ENV };
    delete withoutFlag.REQUEST_LOGGING_ENABLED;
    expect(parseEnv(withoutFlag).REQUEST_LOGGING_ENABLED).toBe(true);
  });

  it('fails with a legible error when JWT_SECRET is too short', () => {
    expect(() => parseEnv({ ...VALID_ENV, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('leaves Stripe keys unset when absent (payments stay disabled)', () => {
    const config = parseEnv({ ...VALID_ENV });

    expect(config.STRIPE_SECRET_KEY).toBeUndefined();
    expect(config.STRIPE_PUBLISHABLE_KEY).toBeUndefined();
    expect(config.STRIPE_WEBHOOK_SECRET).toBeUndefined();
  });

  it('accepts test-mode Stripe keys', () => {
    const config = parseEnv({
      ...VALID_ENV,
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test123',
    });

    expect(config.STRIPE_SECRET_KEY).toBe('sk_test_123');
    expect(config.STRIPE_PUBLISHABLE_KEY).toBe('pk_test_123');
    expect(config.STRIPE_WEBHOOK_SECRET).toBe('whsec_test123');
  });

  it('treats empty Stripe variables as unset', () => {
    const config = parseEnv({
      ...VALID_ENV,
      STRIPE_SECRET_KEY: '',
      STRIPE_PUBLISHABLE_KEY: '   ',
      STRIPE_WEBHOOK_SECRET: '',
    });

    expect(config.STRIPE_SECRET_KEY).toBeUndefined();
    expect(config.STRIPE_PUBLISHABLE_KEY).toBeUndefined();
    expect(config.STRIPE_WEBHOOK_SECRET).toBeUndefined();
  });

  it('rejects live Stripe keys (test mode only, see ADR 0012)', () => {
    expect(() => parseEnv({ ...VALID_ENV, STRIPE_SECRET_KEY: 'sk_live_123' })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    expect(() => parseEnv({ ...VALID_ENV, STRIPE_PUBLISHABLE_KEY: 'pk_live_123' })).toThrow(
      /STRIPE_PUBLISHABLE_KEY/,
    );
  });

  it('rejects a too-short webhook secret', () => {
    expect(() => parseEnv({ ...VALID_ENV, STRIPE_WEBHOOK_SECRET: 'short' })).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });

  it('leaves STRIPE_BASE_URL unset by default (real Stripe API)', () => {
    expect(parseEnv({ ...VALID_ENV }).STRIPE_BASE_URL).toBeUndefined();
  });

  it('accepts a stripe-mock base url and treats empty as unset', () => {
    expect(
      parseEnv({ ...VALID_ENV, STRIPE_BASE_URL: 'http://localhost:12111' }).STRIPE_BASE_URL,
    ).toBe('http://localhost:12111');
    expect(parseEnv({ ...VALID_ENV, STRIPE_BASE_URL: '' }).STRIPE_BASE_URL).toBeUndefined();
    expect(parseEnv({ ...VALID_ENV, STRIPE_BASE_URL: '   ' }).STRIPE_BASE_URL).toBeUndefined();
  });

  it('rejects a non-http STRIPE_BASE_URL', () => {
    expect(() => parseEnv({ ...VALID_ENV, STRIPE_BASE_URL: 'not-a-url' })).toThrow(
      /STRIPE_BASE_URL/,
    );
    expect(() => parseEnv({ ...VALID_ENV, STRIPE_BASE_URL: 'ftp://localhost:21' })).toThrow(
      /STRIPE_BASE_URL/,
    );
  });

  it('defaults to the fake embedding provider with tunable batching/retry knobs', () => {
    const config = parseEnv({ ...VALID_ENV });

    expect(config.EMBEDDING_PROVIDER).toBe('fake');
    expect(config.EMBEDDING_MODEL).toBeUndefined();
    expect(config.EMBEDDING_API_KEY).toBeUndefined();
    expect(config.EMBEDDING_BASE_URL).toBeUndefined();
    expect(config.EMBEDDING_DIM).toBe(1536);
    expect(config.EMBEDDING_BATCH_SIZE).toBe(100);
    expect(config.EMBEDDING_TIMEOUT_MS).toBe(30000);
    expect(config.EMBEDDING_MAX_ATTEMPTS).toBe(4);
    expect(config.EMBEDDING_RETRY_BASE_DELAY_MS).toBe(500);
    expect(config.EMBEDDING_RETRY_MAX_DELAY_MS).toBe(8000);
  });

  it('accepts an openai-compatible embedding configuration', () => {
    const config = parseEnv({
      ...VALID_ENV,
      EMBEDDING_PROVIDER: 'openai-compatible',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_API_KEY: 'sk-test',
      EMBEDDING_BASE_URL: 'https://api.openai.com/v1',
      EMBEDDING_DIM: '768',
    });

    expect(config.EMBEDDING_PROVIDER).toBe('openai-compatible');
    expect(config.EMBEDDING_MODEL).toBe('text-embedding-3-small');
    expect(config.EMBEDDING_BASE_URL).toBe('https://api.openai.com/v1');
    expect(config.EMBEDDING_DIM).toBe(768);
  });

  it('accepts an nvidia embedding configuration (nemotron-3-embed-1b, ADR 0018)', () => {
    const config = parseEnv({
      ...VALID_ENV,
      EMBEDDING_PROVIDER: 'nvidia',
      EMBEDDING_MODEL: 'nvidia/nemotron-3-embed-1b',
      EMBEDDING_API_KEY: 'nvapi-test',
      EMBEDDING_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      EMBEDDING_DIM: '2048',
    });

    expect(config.EMBEDDING_PROVIDER).toBe('nvidia');
    expect(config.EMBEDDING_MODEL).toBe('nvidia/nemotron-3-embed-1b');
    expect(config.EMBEDDING_BASE_URL).toBe('https://integrate.api.nvidia.com/v1');
    expect(config.EMBEDDING_DIM).toBe(2048);
  });

  it('requires base url and model for nvidia too', () => {
    expect(() => parseEnv({ ...VALID_ENV, EMBEDDING_PROVIDER: 'nvidia' })).toThrow(
      /EMBEDDING_BASE_URL and EMBEDDING_MODEL are required/,
    );
  });

  it('treats empty embedding key/url/model as unset', () => {
    const config = parseEnv({
      ...VALID_ENV,
      EMBEDDING_MODEL: '',
      EMBEDDING_API_KEY: '   ',
      EMBEDDING_BASE_URL: '',
    });

    expect(config.EMBEDDING_MODEL).toBeUndefined();
    expect(config.EMBEDDING_API_KEY).toBeUndefined();
    expect(config.EMBEDDING_BASE_URL).toBeUndefined();
  });

  it('requires base url and model for openai-compatible', () => {
    expect(() => parseEnv({ ...VALID_ENV, EMBEDDING_PROVIDER: 'openai-compatible' })).toThrow(
      /EMBEDDING_BASE_URL and EMBEDDING_MODEL are required/,
    );
    expect(() =>
      parseEnv({
        ...VALID_ENV,
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_BASE_URL: 'https://api.openai.com/v1',
      }),
    ).toThrow(/EMBEDDING_BASE_URL and EMBEDDING_MODEL are required/);
  });

  it('rejects unknown providers, bad urls and out-of-range dimensions', () => {
    expect(() => parseEnv({ ...VALID_ENV, EMBEDDING_PROVIDER: 'mystery' })).toThrow(
      /EMBEDDING_PROVIDER/,
    );
    expect(() =>
      parseEnv({
        ...VALID_ENV,
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_MODEL: 'm',
        EMBEDDING_BASE_URL: 'not-a-url',
      }),
    ).toThrow(/EMBEDDING_BASE_URL/);
    expect(() => parseEnv({ ...VALID_ENV, EMBEDDING_DIM: '0' })).toThrow(/EMBEDDING_DIM/);
    // pgvector indexed caps: 2000 (`vector`), 4000 (`halfvec`, ADR 0018).
    expect(() => parseEnv({ ...VALID_ENV, EMBEDDING_DIM: '5000' })).toThrow(/EMBEDDING_DIM/);
  });

  it('defaults to the fake LLM provider with tunable retry knobs', () => {
    const config = parseEnv({ ...VALID_ENV });

    expect(config.LLM_PROVIDER).toBe('fake');
    expect(config.LLM_MODEL).toBeUndefined();
    expect(config.LLM_API_KEY).toBeUndefined();
    expect(config.LLM_BASE_URL).toBeUndefined();
    expect(config.LLM_TIMEOUT_MS).toBe(60000);
    expect(config.LLM_MAX_ATTEMPTS).toBe(3);
    expect(config.LLM_RETRY_BASE_DELAY_MS).toBe(500);
    expect(config.LLM_RETRY_MAX_DELAY_MS).toBe(8000);
    expect(config.LLM_MAX_TOKENS).toBe(1024);
  });

  it('accepts an openai-compatible LLM configuration', () => {
    const config = parseEnv({
      ...VALID_ENV,
      LLM_PROVIDER: 'openai-compatible',
      LLM_MODEL: 'gpt-4o-mini',
      LLM_API_KEY: 'sk-test',
      LLM_BASE_URL: 'https://api.openai.com/v1',
    });

    expect(config.LLM_PROVIDER).toBe('openai-compatible');
    expect(config.LLM_MODEL).toBe('gpt-4o-mini');
    expect(config.LLM_BASE_URL).toBe('https://api.openai.com/v1');
  });

  it('accepts an anthropic LLM configuration without a base url (ADR 0024)', () => {
    const config = parseEnv({
      ...VALID_ENV,
      LLM_PROVIDER: 'anthropic',
      LLM_MODEL: 'claude-haiku-4-5',
      LLM_API_KEY: 'sk-ant-test',
    });

    expect(config.LLM_PROVIDER).toBe('anthropic');
    expect(config.LLM_MODEL).toBe('claude-haiku-4-5');
    expect(config.LLM_BASE_URL).toBeUndefined();
  });

  it('requires a model for non-fake LLM providers and a base url for openai-compatible', () => {
    expect(() => parseEnv({ ...VALID_ENV, LLM_PROVIDER: 'anthropic' })).toThrow(/LLM_MODEL/);
    expect(() => parseEnv({ ...VALID_ENV, LLM_PROVIDER: 'openai-compatible' })).toThrow(
      /LLM_MODEL/,
    );
    expect(() =>
      parseEnv({
        ...VALID_ENV,
        LLM_PROVIDER: 'openai-compatible',
        LLM_MODEL: 'gpt-4o-mini',
      }),
    ).toThrow(/LLM_BASE_URL/);
  });

  it('treats empty LLM key/url/model as unset', () => {
    const config = parseEnv({
      ...VALID_ENV,
      LLM_MODEL: '',
      LLM_API_KEY: '   ',
      LLM_BASE_URL: '',
    });

    expect(config.LLM_MODEL).toBeUndefined();
    expect(config.LLM_API_KEY).toBeUndefined();
    expect(config.LLM_BASE_URL).toBeUndefined();
  });

  it('rejects unknown LLM providers and bad urls', () => {
    expect(() => parseEnv({ ...VALID_ENV, LLM_PROVIDER: 'mystery' })).toThrow(/LLM_PROVIDER/);
    expect(() =>
      parseEnv({
        ...VALID_ENV,
        LLM_PROVIDER: 'openai-compatible',
        LLM_MODEL: 'm',
        LLM_BASE_URL: 'not-a-url',
      }),
    ).toThrow(/LLM_BASE_URL/);
  });

  it('disables the database keep-alive by default (local DB never sleeps)', () => {
    const config = parseEnv({ ...VALID_ENV });

    expect(config.KEEPALIVE_ENABLED).toBe(false);
    expect(config.KEEPALIVE_INTERVAL_MINUTES).toBe(60);
  });

  it('enables the keep-alive for production Supabase (ADR 0072)', () => {
    const config = parseEnv({
      ...VALID_ENV,
      KEEPALIVE_ENABLED: 'true',
      KEEPALIVE_INTERVAL_MINUTES: '10',
    });

    expect(config.KEEPALIVE_ENABLED).toBe(true);
    expect(config.KEEPALIVE_INTERVAL_MINUTES).toBe(10);
  });

  it('rejects an out-of-range keep-alive interval', () => {
    expect(() => parseEnv({ ...VALID_ENV, KEEPALIVE_INTERVAL_MINUTES: '0' })).toThrow(
      /KEEPALIVE_INTERVAL_MINUTES/,
    );
    expect(() => parseEnv({ ...VALID_ENV, KEEPALIVE_INTERVAL_MINUTES: '2000' })).toThrow(
      /KEEPALIVE_INTERVAL_MINUTES/,
    );
  });
});
