import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config/env.schema.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { FakeLlmAdapter } from '../../ai/adapters/fake-llm.adapter.js';
import { AiProviderError } from '../../ai/ai-provider.error.js';
import { LlmJsonError } from '../../ai/common/generate-json.js';
import type { RetrievalHit } from '../../retrieval/retrieval.service.js';
import type { RetrievalService } from '../../retrieval/retrieval.service.js';
import type { ChatSessionsService, ChatSessionOwner } from '../chat-sessions.service.js';
import type { IntentService } from '../intent/intent.service.js';
import type { PurchaseIntent } from '../intent/purchase-intent.schema.js';
import { splitIntoDeltas } from '../chat-sessions.controller.js';
import {
  buildDeterministicMessage,
  buildSpecCondition,
  keepValidItems,
  RECOMMEND_BRAND_BONUS,
  RecommendService,
  scoreCandidate,
  summarizeSpecs,
  toCandidateFilters,
  toProductCard,
  type RecommendCandidate,
} from './recommendation.service.js';
import {
  buildRecommendUserMessage,
  loadRecommendSystemPrompt,
  renderRecommendSystemPrompt,
} from './prompts/recommend.prompt.js';

const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const OWNER: ChatSessionOwner = { kind: 'user', userId: 'user-1' };
const CANDIDATE_A = '11111111-1111-4111-8111-111111111111';
const CANDIDATE_B = '22222222-2222-4222-8222-222222222222';
const INVENTED_ID = '99999999-9999-4999-8999-999999999999';

const CONFIG = {
  SUPPORTED_LOCALES: ['en', 'es'],
  DEFAULT_LOCALE: 'en',
  BASE_CURRENCY: 'USD',
  SUPPORTED_CURRENCIES: ['USD', 'EUR'],
  ADVISOR_SESSION_MAX_MESSAGES: 100,
} as unknown as AppConfig;

function hit(
  chunkId: string,
  productId: string | null,
  content = 'evidence content',
): RetrievalHit {
  return {
    chunkId,
    documentId: `doc-${chunkId}`,
    productId,
    content,
    locale: 'en',
    score: 0.03,
    source: { title: `Title ${chunkId}`, docType: 'MANUAL', sourceUrl: null },
  };
}

function candidateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CANDIDATE_A,
    name: 'Laptop A',
    slug: 'laptop-a',
    specs: { ram_gb: 16, storage_gb: 512 },
    brandName: 'TestBrand',
    categorySlug: 'laptops',
    priceAmount: 700_00,
    priceCurrency: 'USD',
    available: 5,
    imageUrl: null,
    score: 12,
    ...overrides,
  };
}

function laptopIntent(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    categorySlug: 'laptops',
    maxPrice: { amount: 800_00, currency: 'USD' },
    useCases: ['study engineering'],
    mustHaveSpecs: {},
    brandsInclude: [],
    brandsExclude: [],
    missingInfo: [],
    ...overrides,
  };
}

function draftJson(
  text: string,
  items: { productId: string; reason: string; citations?: number[] }[],
): string {
  return JSON.stringify({
    text,
    items: items.map((item) => ({ citations: [1], ...item })),
  });
}

interface ServiceMocks {
  service: RecommendService;
  seenSql: Prisma.Sql[];
  queryRaw: ReturnType<typeof vi.fn>;
  unansweredCreate: ReturnType<typeof vi.fn>;
  addMessage: ReturnType<typeof vi.fn>;
  extractIntent: ReturnType<typeof vi.fn>;
  retrievalSearch: ReturnType<typeof vi.fn>;
  llm: FakeLlmAdapter;
}

function buildService(options: {
  candidateRows?: Record<string, unknown>[] | ((sql: Prisma.Sql) => Record<string, unknown>[]);
  intent?: PurchaseIntent | Error;
  llmTexts?: string[];
  hits?: RetrievalHit[];
  historyMessages?: { role: 'USER' | 'ASSISTANT'; content: string }[];
}): ServiceMocks {
  const seenSql: Prisma.Sql[] = [];
  const rowsOrFn = options.candidateRows ?? [candidateRow()];
  const queryRaw = vi.fn((query: Prisma.Sql) => {
    seenSql.push(query);
    const rows = typeof rowsOrFn === 'function' ? rowsOrFn(query) : rowsOrFn;
    return Promise.resolve(rows);
  });
  const unansweredCreate = vi.fn().mockResolvedValue({ id: 'u1' });
  const prisma = {
    $queryRaw: queryRaw,
    unansweredQuery: { create: unansweredCreate },
  } as unknown as PrismaService;

  const historyMessages = options.historyMessages ?? [];
  const addMessage = vi.fn(
    (
      _sessionId: string,
      _owner: ChatSessionOwner,
      input: { role: 'USER' | 'ASSISTANT'; content: string },
    ) =>
      Promise.resolve({
        id: `created-${input.role}`,
        role: input.role,
        content: input.content,
        citations: [],
        products: [],
        createdAt: new Date(),
      }),
  );
  const chatSessions = {
    assertSessionOwned: vi.fn().mockResolvedValue(undefined),
    getSessionHistory: vi.fn().mockResolvedValue({
      id: SESSION_ID,
      messageCount: historyMessages.length,
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: historyMessages.map((message, index) => ({
        id: `m-${String(index)}`,
        role: message.role,
        content: message.content,
        citations: [],
        products: [],
        createdAt: new Date(),
      })),
    }),
    addMessage,
  } as unknown as ChatSessionsService;

  const extractIntent = vi.fn();
  if (options.intent instanceof Error) {
    extractIntent.mockRejectedValue(options.intent);
  } else {
    extractIntent.mockResolvedValue(options.intent ?? laptopIntent());
  }
  const intent = { extractIntent } as unknown as IntentService;

  const retrievalSearch = vi.fn().mockResolvedValue(options.hits ?? []);
  const retrieval = {
    search: retrievalSearch,
    searchFulltextOnly: vi.fn().mockResolvedValue(options.hits ?? []),
  } as unknown as RetrievalService;

  const llm = new FakeLlmAdapter({ defaultText: 'unused' });
  if (options.llmTexts !== undefined) {
    llm.enqueueTexts(options.llmTexts);
  }

  const service = new RecommendService(prisma, chatSessions, intent, retrieval, llm, CONFIG);
  return {
    service,
    seenSql,
    queryRaw,
    unansweredCreate,
    addMessage,
    extractIntent,
    retrievalSearch,
    llm,
  };
}

describe('RecommendService.recommend (unit, mocked database)', () => {
  it('recommends SQL candidates with hydrated cards and citations (happy path)', async () => {
    const rows = [
      candidateRow(),
      candidateRow({ id: CANDIDATE_B, name: 'Laptop B', priceAmount: 750_00, score: 6 }),
    ];
    const { service, seenSql, llm, addMessage } = buildService({
      candidateRows: rows,
      hits: [hit('a', CANDIDATE_A, '16 GB RAM for students'), hit('b', null, '2-year warranty')],
      llmTexts: [
        draftJson('Both fit your engineering studies [1] with warranty coverage [2].', [
          { productId: CANDIDATE_A, reason: '16 GB RAM for your classes', citations: [1] },
          { productId: CANDIDATE_B, reason: '512 GB storage for projects', citations: [1, 2] },
        ]),
      ],
    });

    const response = await service.recommend(SESSION_ID, OWNER, {
      content: 'laptop for studying engineering, under $800',
      locale: 'en',
    });

    expect(response.products).toHaveLength(2);
    expect(response.products[0]).toMatchObject({
      productId: CANDIDATE_A,
      name: 'Laptop A',
      priceAmount: 700_00,
      currency: 'USD',
      inStock: true,
      reason: '16 GB RAM for your classes',
    });
    // Citations resolve against the delivered evidence only.
    expect(response.products[0]?.citations.map((citation) => citation.n)).toEqual([1]);
    expect(response.products[1]?.citations.map((citation) => citation.n)).toEqual([1, 2]);
    expect(response.message).toContain('[1]');
    // One candidate query: ACTIVE + in-stock + budget bound as values.
    expect(seenSql).toHaveLength(1);
    expect(seenSql[0]?.sql).toContain("'ACTIVE'");
    expect(seenSql[0]?.sql).toContain('COALESCE');
    expect(seenSql[0]?.values).toContain(800_00);
    expect(seenSql[0]?.values).toContain('laptops');
    // One drafting LLM call; the ASSISTANT turn persists cards + citations.
    expect(llm.calls).toHaveLength(1);
    expect(addMessage).toHaveBeenCalledTimes(2);
    const assistantCall = addMessage.mock.calls.at(1)?.at(2) as { products: unknown[] };
    expect(assistantCall.products).toHaveLength(2);
  });

  it('asks one clarification question without SQL or drafting when budget/category are missing', async () => {
    const { service, seenSql, llm, retrievalSearch } = buildService({
      intent: laptopIntent({
        categorySlug: undefined,
        maxPrice: undefined,
        minPrice: undefined,
        useCases: [],
        missingInfo: ['budget', 'use', 'category'],
      }),
    });

    const response = await service.recommend(SESSION_ID, OWNER, {
      content: 'quiero algo para estudiar',
      locale: 'es',
    });

    expect(response.products).toEqual([]);
    expect(response.clarifyingQuestion).toContain('presupuesto');
    expect(response.message).toBe(response.clarifyingQuestion);
    expect(seenSql).toHaveLength(0);
    expect(retrievalSearch).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
  });

  it('explains which constraint to relax when no candidates match (strict budget)', async () => {
    const { service, seenSql, unansweredCreate } = buildService({
      candidateRows: (query) =>
        query.sql.includes('COUNT(*)')
          ? [{ count: 0 }]
          : query.sql.includes('"score"')
            ? []
            : [{ priceAmount: 900_00 }],
      llmTexts: [],
    });

    const response = await service.recommend(SESSION_ID, OWNER, {
      content: 'laptop for studying engineering, under $800',
      locale: 'en',
    });

    expect(response.products).toEqual([]);
    expect(response.message).toContain('900');
    expect(response.message.toLowerCase()).toContain('budget');
    expect(unansweredCreate).toHaveBeenCalledWith({
      data: {
        query: 'laptop for studying engineering, under $800',
        productId: null,
        sessionId: SESSION_ID,
        reason: 'no_candidates',
      },
    });
    // Candidates query + cheapest-ignoring-price query (relax hints stop early).
    expect(seenSql.length).toBeGreaterThanOrEqual(2);
  });

  it('drops an invented productId and regenerates once', async () => {
    const { service, llm } = buildService({
      candidateRows: [candidateRow()],
      hits: [hit('a', CANDIDATE_A, '16 GB RAM')],
      llmTexts: [
        draftJson('Pick this one [1] and a secret one.', [
          { productId: CANDIDATE_A, reason: 'fits', citations: [1] },
          { productId: INVENTED_ID, reason: 'invented', citations: [1] },
        ]),
        draftJson('Pick this one [1].', [
          { productId: CANDIDATE_A, reason: 'fits', citations: [1] },
        ]),
      ],
    });

    const response = await service.recommend(SESSION_ID, OWNER, {
      content: 'laptop under $800',
      locale: 'en',
    });

    expect(llm.calls).toHaveLength(2);
    expect(response.products.map((card) => card.productId)).toEqual([CANDIDATE_A]);
  });

  it('falls back to the deterministic list when the LLM keeps inventing products', async () => {
    const bad = draftJson('Secret pick.', [{ productId: INVENTED_ID, reason: 'invented' }]);
    const { service, llm } = buildService({
      candidateRows: [candidateRow()],
      hits: [hit('a', CANDIDATE_A, '16 GB RAM')],
      llmTexts: [bad, bad],
    });

    const response = await service.recommend(SESSION_ID, OWNER, {
      content: 'laptop under $800',
      locale: 'en',
    });

    expect(llm.calls).toHaveLength(2);
    // No LLM redaction: deterministic template with the SQL candidate.
    expect(response.message).toContain('Laptop A');
    expect(response.message).toContain('ram_gb');
    expect(response.products).toHaveLength(1);
    expect(response.products[0]).toMatchObject({ productId: CANDIDATE_A, priceAmount: 700_00 });
  });

  it('never surfaces out-of-stock rows even if SQL returned them (race guard)', async () => {
    const { service } = buildService({
      candidateRows: [candidateRow({ available: 0 })],
      hits: [],
      llmTexts: [
        draftJson('Take it.', [{ productId: CANDIDATE_A, reason: 'fits', citations: [] }]),
      ],
    });

    const response = await service.recommend(SESSION_ID, OWNER, {
      content: 'laptop under $800',
      locale: 'en',
    });

    expect(response.products).toEqual([]);
  });

  it('rejects a full session before any costly work', async () => {
    const { service, extractIntent } = buildService({
      historyMessages: Array.from({ length: 99 }, (_, index) => ({
        role: 'USER' as const,
        content: `message ${String(index)}`,
      })),
    });

    await expect(
      service.recommend(SESSION_ID, OWNER, { content: 'laptop under $800' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(extractIntent).not.toHaveBeenCalled();
  });

  it('404s on foreign sessions before any costly work', async () => {
    const seenSql: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: vi.fn((query: Prisma.Sql) => {
        seenSql.push(query);
        return Promise.resolve([]);
      }),
      unansweredQuery: { create: vi.fn() },
    } as unknown as PrismaService;
    const chatSessions = {
      assertSessionOwned: vi
        .fn()
        .mockRejectedValue(new NotFoundException({ message: 'Chat session not found' })),
      getSessionHistory: vi.fn(),
      addMessage: vi.fn(),
    } as unknown as ChatSessionsService;
    const intent = { extractIntent: vi.fn() } as unknown as IntentService;
    const retrieval = {
      search: vi.fn(),
      searchFulltextOnly: vi.fn(),
    } as unknown as RetrievalService;
    const llm = new FakeLlmAdapter({ defaultText: 'unused' });
    const service = new RecommendService(prisma, chatSessions, intent, retrieval, llm, CONFIG);

    await expect(
      service.recommend(SESSION_ID, { kind: 'user', userId: 'intruder' }, { content: 'hi' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(seenSql).toHaveLength(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('maps provider outages to 503 during drafting', async () => {
    const prismaMock = {
      $queryRaw: vi.fn().mockResolvedValue([candidateRow()]),
      unansweredQuery: { create: vi.fn() },
    } as unknown as PrismaService;
    const chatMock = {
      assertSessionOwned: vi.fn().mockResolvedValue(undefined),
      getSessionHistory: vi.fn().mockResolvedValue({
        id: SESSION_ID,
        messageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [],
      }),
      addMessage: vi.fn().mockResolvedValue({ id: 'm' }),
    } as unknown as ChatSessionsService;
    const intentMock = {
      extractIntent: vi.fn().mockResolvedValue(laptopIntent()),
    } as unknown as IntentService;
    const retrievalMock = {
      search: vi.fn().mockResolvedValue([]),
      searchFulltextOnly: vi.fn().mockResolvedValue([]),
    } as unknown as RetrievalService;
    const rejectingLlm = {
      providerName: 'anthropic',
      model: 'rejected-model',
      generate: () => Promise.reject(new AiProviderError('auth', 'denied', 'anthropic')),
      stream: async function* (): AsyncIterable<string> {},
    } as unknown as FakeLlmAdapter;
    const broken = new RecommendService(
      prismaMock,
      chatMock,
      intentMock,
      retrievalMock,
      rejectingLlm,
      CONFIG,
    );

    await expect(
      broken.recommend(SESSION_ID, OWNER, { content: 'laptop under $800' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('asks for the budget when intent extraction never converges', async () => {
    const { service, seenSql } = buildService({
      intent: new LlmJsonError('bad json', { attempts: 2, issues: ['not json'] }),
    });

    const response = await service.recommend(SESSION_ID, OWNER, {
      content: 'laptop por favor',
      locale: 'es',
    });

    expect(response.products).toEqual([]);
    expect(response.clarifyingQuestion).toContain('presupuesto');
    expect(seenSql).toHaveLength(0);
  });

  it('sends only candidate evidence to the LLM (other products excluded)', async () => {
    const { service, llm } = buildService({
      candidateRows: [candidateRow()],
      hits: [
        hit('a', CANDIDATE_A, 'candidate evidence text'),
        hit('x', 'other-product-id', 'other product text'),
        hit('p', null, 'policy text'),
      ],
      llmTexts: [
        draftJson('Take it [1].', [{ productId: CANDIDATE_A, reason: 'fits', citations: [1] }]),
      ],
    });

    await service.recommend(SESSION_ID, OWNER, { content: 'laptop under $800' });

    const sent = llm.calls.at(0)?.messages.at(0)?.content ?? '';
    expect(sent).toContain('candidate evidence text');
    expect(sent).toContain('policy text');
    expect(sent).not.toContain('other product text');
    // The prompt carries ids + specs but never prices or stock figures.
    expect(sent).toContain(CANDIDATE_A);
    expect(sent).not.toContain('70000');
  });
});

describe('toCandidateFilters', () => {
  it('keeps same-currency bounds and drops foreign-currency bounds (no conversion)', () => {
    const filters = toCandidateFilters(
      laptopIntent({
        maxPrice: { amount: 800_00, currency: 'USD' },
        minPrice: { amount: 100_00, currency: 'EUR' },
      }),
      'USD',
    );

    expect(filters.maxPrice).toBe(800_00);
    expect(filters.minPrice).toBeUndefined();
  });

  it('lowercases brand lists for case-insensitive matching', () => {
    const filters = toCandidateFilters(
      laptopIntent({ brandsInclude: ['Lenovo'], brandsExclude: ['HP'] }),
      'USD',
    );

    expect(filters.brandsInclude).toEqual(['lenovo']);
    expect(filters.brandsExclude).toEqual(['hp']);
  });
});

describe('scoreCandidate', () => {
  it('rewards preferred brands and cheaper prices within budget', () => {
    const filters = { brandsInclude: ['lenovo'], maxPrice: 800_00 };

    expect(scoreCandidate({ brandName: 'Lenovo', priceAmount: 700_00 }, filters)).toBe(
      RECOMMEND_BRAND_BONUS + 13,
    );
    expect(scoreCandidate({ brandName: 'HP', priceAmount: 700_00 }, filters)).toBe(13);
    expect(scoreCandidate({ brandName: 'HP', priceAmount: 800_00 }, filters)).toBe(0);
  });

  it('scores brand only when no budget exists', () => {
    expect(
      scoreCandidate({ brandName: 'Lenovo', priceAmount: 1 }, { brandsInclude: ['lenovo'] }),
    ).toBe(RECOMMEND_BRAND_BONUS);
  });
});

describe('keepValidItems', () => {
  it('drops ids outside the closed set', () => {
    const items = keepValidItems(
      [
        { productId: CANDIDATE_A, reason: 'ok', citations: [] },
        { productId: INVENTED_ID, reason: 'bad', citations: [] },
      ],
      new Set([CANDIDATE_A]),
    );

    expect(items.map((item) => item.productId)).toEqual([CANDIDATE_A]);
  });
});

describe('buildSpecCondition', () => {
  it('binds text, boolean and numeric requirements as parameters', () => {
    for (const condition of [
      buildSpecCondition('ram_type', 'DDR5'),
      buildSpecCondition('touchscreen', true),
      buildSpecCondition('ram_gb', 16),
    ]) {
      expect(condition).toBeInstanceOf(Prisma.Sql);
      expect(condition.sql).toContain('specs');
    }
    expect(buildSpecCondition('ram_gb', 16).values).toContain(16);
    expect(buildSpecCondition('ram_type', 'DDR5').values).toContain('DDR5');
  });
});

describe('toProductCard', () => {
  function candidate(overrides: Partial<RecommendCandidate> = {}): RecommendCandidate {
    return {
      id: CANDIDATE_A,
      name: 'Laptop A',
      slug: 'laptop-a',
      specs: { ram_gb: 16 },
      brandName: 'TestBrand',
      categorySlug: 'laptops',
      priceAmount: 700_00,
      currency: 'USD',
      available: 5,
      imageUrl: null,
      score: 1,
      ...overrides,
    };
  }

  it('hydrates display data from SQL', () => {
    const card = toProductCard(candidate(), 'fits', []);

    expect(card).toMatchObject({
      productId: CANDIDATE_A,
      name: 'Laptop A',
      priceAmount: 700_00,
      currency: 'USD',
      inStock: true,
      reason: 'fits',
    });
  });

  it('returns null for unavailable rows', () => {
    expect(toProductCard(candidate({ available: 0 }), 'fits', [])).toBeNull();
  });
});

describe('buildDeterministicMessage / summarizeSpecs', () => {
  it('lists candidates with SQL specs and no LLM redaction', () => {
    const rows: RecommendCandidate[] = [
      {
        id: CANDIDATE_A,
        name: 'Laptop A',
        slug: 'laptop-a',
        specs: { ram_gb: 16 },
        brandName: 'TestBrand',
        categorySlug: 'laptops',
        priceAmount: 700_00,
        currency: 'USD',
        available: 3,
        imageUrl: null,
        score: 1,
      },
    ];

    expect(buildDeterministicMessage(rows, 'es').text).toContain('Laptop A');
    expect(buildDeterministicMessage(rows, 'en').text).toContain('Based on your budget');
    expect(summarizeSpecs({})).toContain('ficha');
  });
});

describe('recommend prompt (versioned source)', () => {
  it('loads the v1 markdown and renders the locale', () => {
    const template = loadRecommendSystemPrompt();

    expect(template).toContain('{{locale}}');
    expect(template).toContain('CANDIDATE PRODUCTS');
    expect(template).toContain('untrusted');
    expect(template).toContain('ONLY a valid JSON object');

    const rendered = renderRecommendSystemPrompt(template, 'es');
    expect(rendered).not.toContain('{{locale}}');
  });

  it('builds a user message with ids/specs and numbered chunks, no prices', () => {
    const message = buildRecommendUserMessage({
      question: 'laptop?',
      useCases: ['study'],
      candidates: [{ id: CANDIDATE_A, name: 'Laptop A', specs: { ram_gb: 16 } }],
      hits: [hit('a', CANDIDATE_A, 'chunk one')],
    });

    expect(message).toContain(CANDIDATE_A);
    expect(message).toContain('ram_gb');
    expect(message).toContain('--- chunk [1]');
    expect(message).not.toContain('70000');
  });
});

describe('splitIntoDeltas', () => {
  it('splits text into non-empty chunks that rejoin to the original', () => {
    const text = 'Estas opciones encajan con tu presupuesto [1].';
    const deltas = splitIntoDeltas(text);

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(text);
  });
});
