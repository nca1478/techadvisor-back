import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../config/env.schema.js';
import { FakeLlmAdapter } from '../../ai/adapters/fake-llm.adapter.js';
import { LlmJsonError } from '../../ai/common/generate-json.js';
import {
  buildClarificationQuestion,
  completeMissingInfo,
  IntentService,
  sanitizeIntent,
} from './intent.service.js';
import {
  buildIntentUserMessage,
  loadIntentSystemPrompt,
  renderIntentSystemPrompt,
} from './intent.prompt.js';
import type { PurchaseIntent } from './purchase-intent.schema.js';

const CONFIG = {
  SUPPORTED_LOCALES: ['en', 'es'],
  DEFAULT_LOCALE: 'en',
  BASE_CURRENCY: 'USD',
  SUPPORTED_CURRENCIES: ['USD', 'EUR'],
} as unknown as AppConfig;

function buildService(llm: FakeLlmAdapter): IntentService {
  return new IntentService(llm, CONFIG);
}

function intentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    categorySlug: 'laptops',
    useCases: ['programming with Docker'],
    mustHaveSpecs: {},
    brandsInclude: [],
    brandsExclude: [],
    missingInfo: [],
    ...overrides,
  });
}

describe('IntentService.extractIntent (fake LLM)', () => {
  it('maps es and en Docker-laptop phrases to the same category, budget and use', async () => {
    const esLlm = new FakeLlmAdapter();
    esLlm.enqueueTexts([
      intentJson({ categorySlug: 'laptops', useCases: ['programar con Docker'] }),
    ]);
    const enLlm = new FakeLlmAdapter();
    enLlm.enqueueTexts([
      intentJson({ categorySlug: 'laptops', useCases: ['programming with Docker'] }),
    ]);

    const es = await buildService(esLlm).extractIntent(
      [{ role: 'user', content: 'portátil para programar con Docker, máximo 800 dólares' }],
      { locale: 'es' },
    );
    const en = await buildService(enLlm).extractIntent(
      [{ role: 'user', content: 'laptop for programming with Docker, under $800' }],
      { locale: 'en' },
    );

    for (const intent of [es, en]) {
      expect(intent.categorySlug).toBe('laptops');
      expect(intent.maxPrice).toEqual({ amount: 80000, currency: 'USD' });
      expect(intent.useCases.join(' ').toLowerCase()).toContain('docker');
    }
    expect(es.maxPrice).toEqual(en.maxPrice);
    expect(es.categorySlug).toBe(en.categorySlug);
  });

  it('fills the budget deterministically when the model omits it', async () => {
    const llm = new FakeLlmAdapter();
    llm.enqueueTexts([intentJson({ useCases: ['study'] })]);
    const service = buildService(llm);

    const intent = await service.extractIntent(
      [{ role: 'user', content: 'laptop for studying, under $800' }],
      { locale: 'en' },
    );

    expect(intent.maxPrice).toEqual({ amount: 80000, currency: 'USD' });
    expect(intent.missingInfo).not.toContain('budget');
  });

  it('lets the deterministic parse win over a contradicting model budget', async () => {
    const llm = new FakeLlmAdapter();
    llm.enqueueTexts([
      intentJson({ maxPrice: { amount: 99900, currency: 'EUR' }, useCases: ['study'] }),
    ]);
    const service = buildService(llm);

    const intent = await service.extractIntent(
      [{ role: 'user', content: 'laptop for studying, under $800' }],
      { locale: 'en' },
    );

    expect(intent.maxPrice).toEqual({ amount: 80000, currency: 'USD' });
  });

  it('discards unknown spec keys and unknown categories instead of failing', async () => {
    const llm = new FakeLlmAdapter();
    llm.enqueueTexts([
      intentJson({
        categorySlug: 'starships',
        useCases: ['gaming'],
        mustHaveSpecs: { ram_gb: 16, hyperdrive: 'fast' },
        missingInfo: [],
      }),
    ]);
    const service = buildService(llm);

    const intent = await service.extractIntent(
      [{ role: 'user', content: 'gaming laptop with 16GB RAM' }],
      { locale: 'en' },
    );

    expect(intent.categorySlug).toBeUndefined();
    expect(intent.mustHaveSpecs).toEqual({ ram_gb: 16 });
    expect(intent.missingInfo).toContain('category');
  });

  it('completes missingInfo for budget and use gaps', async () => {
    const llm = new FakeLlmAdapter();
    llm.enqueueTexts([JSON.stringify({})]);
    const service = buildService(llm);

    const intent = await service.extractIntent([{ role: 'user', content: 'hola, busco algo' }], {
      locale: 'es',
    });

    expect(intent.missingInfo).toContain('budget');
    expect(intent.missingInfo).toContain('use');
    expect(intent.missingInfo).toContain('category');
  });

  it('extracts a floor ("desde 300 dólares") as minPrice', async () => {
    const llm = new FakeLlmAdapter();
    llm.enqueueTexts([intentJson({ useCases: ['ofimática'] })]);
    const service = buildService(llm);

    const intent = await service.extractIntent(
      [{ role: 'user', content: 'busco portátil desde 300 dólares para ofimática' }],
      { locale: 'es' },
    );

    expect(intent.minPrice).toEqual({ amount: 30000, currency: 'USD' });
    expect(intent.maxPrice).toBeUndefined();
  });

  it('skips the LLM on empty conversations with a fully-missing intent', async () => {
    const llm = new FakeLlmAdapter();
    const service = buildService(llm);

    const intent = await service.extractIntent([], { locale: 'en' });

    expect(intent).toMatchObject({
      useCases: [],
      mustHaveSpecs: {},
      missingInfo: ['category', 'budget', 'use'],
    });
    expect(llm.calls).toHaveLength(0);
  });

  it('retries once after invalid JSON and then succeeds', async () => {
    const llm = new FakeLlmAdapter();
    llm.enqueueTexts(['not json at all', intentJson({ useCases: ['study'] })]);
    const service = buildService(llm);

    const intent = await service.extractIntent([{ role: 'user', content: 'laptop for studying' }], {
      locale: 'en',
    });

    expect(intent.categorySlug).toBe('laptops');
    expect(llm.calls).toHaveLength(2);
  });

  it('throws a controlled typed error after the retry is consumed', async () => {
    const llm = new FakeLlmAdapter();
    llm.enqueueTexts(['garbage one', 'garbage two']);
    const service = buildService(llm);

    const error = await service
      .extractIntent([{ role: 'user', content: 'laptop for studying' }], { locale: 'en' })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(LlmJsonError);
    expect((error as LlmJsonError).attempts).toBe(2);
    expect(llm.calls).toHaveLength(2);
  });
});

describe('sanitizeIntent', () => {
  function base(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
    return {
      useCases: [],
      mustHaveSpecs: {},
      brandsInclude: [],
      brandsExclude: [],
      missingInfo: [],
      ...overrides,
    };
  }

  it('trims and dedupes lists case-insensitively', () => {
    const intent = sanitizeIntent(
      base({ useCases: [' Docker ', 'docker', 'Study'], brandsInclude: [' Lenovo', 'lenovo '] }),
    );

    expect(intent.useCases).toEqual(['Docker', 'Study']);
    expect(intent.brandsInclude).toEqual(['Lenovo']);
  });
});

describe('completeMissingInfo', () => {
  it('keeps brand/specs gaps reported by the model without adding new ones', () => {
    const intent: PurchaseIntent = {
      categorySlug: 'laptops',
      maxPrice: { amount: 80000, currency: 'USD' },
      useCases: ['study'],
      mustHaveSpecs: {},
      brandsInclude: [],
      brandsExclude: [],
      missingInfo: ['brand'],
    };

    completeMissingInfo(intent);

    expect(intent.missingInfo).toEqual(['brand']);
  });
});

describe('buildClarificationQuestion', () => {
  function base(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
    return {
      useCases: ['study'],
      mustHaveSpecs: {},
      brandsInclude: [],
      brandsExclude: [],
      missingInfo: [],
      categorySlug: 'laptops',
      maxPrice: { amount: 80000, currency: 'USD' },
      ...overrides,
    };
  }

  it('returns null when nothing is missing', () => {
    expect(buildClarificationQuestion(base(), 'en')).toBeNull();
  });

  it('asks exactly one budget question first (es/en)', () => {
    const intent = base({
      maxPrice: undefined,
      minPrice: undefined,
      missingInfo: ['budget', 'use'],
    });

    expect(buildClarificationQuestion(intent, 'es')).toContain('presupuesto');
    expect(buildClarificationQuestion(intent, 'en')).toContain('budget');
  });
});

describe('intent prompt (versioned source)', () => {
  it('loads the v1 markdown and renders every placeholder', () => {
    const template = loadIntentSystemPrompt();

    expect(template).toContain('{{locale}}');
    expect(template).toContain('{{categories}}');
    expect(template).toContain('ONLY the JSON object');

    const rendered = renderIntentSystemPrompt(template, {
      locale: 'es',
      baseCurrency: 'USD',
      currencies: ['USD', 'EUR'],
      categories: ['laptops'],
      specKeys: ['ram_gb'],
    });
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
    expect(rendered).toContain('laptops');
    expect(rendered).toContain('ram_gb');
  });

  it('builds a numbered user message with the detected budget', () => {
    const message = buildIntentUserMessage({
      turns: [{ role: 'user', content: 'laptop under $800' }],
      budget: { maxPrice: { amount: 80000, currency: 'USD' } },
      locale: 'en',
      currency: 'USD',
    });

    expect(message).toContain('[1] USER: laptop under $800');
    expect(message).toContain('DETECTED BUDGET');
    expect(message).toContain('80000 USD');
  });
});
