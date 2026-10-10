import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config/env.schema.js';
import type { RequestUser } from '../../auth/jwt-auth.guard.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import { FakeLlmAdapter } from '../../ai/adapters/fake-llm.adapter.js';
import type { RetrievalService, RetrievalHit } from '../../retrieval/retrieval.service.js';
import { SUPPORT_DOC_TYPES, supportAbstentionMessage, SupportService } from './support.service.js';
import {
  buildSupportUserMessage,
  isExceptionRequest,
  loadSupportSystemPrompt,
  renderSupportSystemPrompt,
} from './support.prompt.js';

const ORDER_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_ORDER_ID = '88888888-8888-4888-8888-888888888888';
const USER: RequestUser = { id: 'user-1', role: 'CUSTOMER' };

const CONFIG = {
  SUPPORTED_LOCALES: ['en', 'es'],
  DEFAULT_LOCALE: 'en',
  ADVISOR_ABSTAIN_MIN_SCORE: 0.016,
} as unknown as AppConfig;

function hit(
  chunkId: string,
  score: number,
  content = 'policy evidence content',
  docType = 'POLICY',
): RetrievalHit {
  return {
    chunkId,
    documentId: `doc-${chunkId}`,
    productId: null,
    content,
    locale: 'es',
    score,
    source: { title: `Policy ${chunkId}`, docType, sourceUrl: null },
  };
}

function orderRow() {
  return {
    id: ORDER_ID,
    status: 'PAID',
    currency: 'USD',
    totalAmount: 200_00,
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    _count: { items: 2 },
  };
}

function buildService(options: {
  hits?: RetrievalHit[];
  llmText?: string;
  llm?: FakeLlmAdapter;
  order?: ReturnType<typeof orderRow> | null;
}) {
  const searchMock = vi.fn().mockResolvedValue(options.hits ?? []);
  const retrieval = { search: searchMock } as unknown as RetrievalService;
  const createMock = vi.fn().mockResolvedValue({ id: 'u1' });
  const findFirstMock = vi
    .fn()
    .mockResolvedValue(options.order === undefined ? null : options.order);
  const prisma = {
    order: { findFirst: findFirstMock },
    unansweredQuery: { create: createMock },
  } as unknown as PrismaService;
  const llm =
    options.llm ?? new FakeLlmAdapter({ defaultText: options.llmText ?? 'Respuesta [1].' });
  const service = new SupportService(prisma, retrieval, llm, CONFIG);
  return { service, searchMock, createMock, findFirstMock, llm };
}

/** First user message sent to the fake LLM (empty when never called). */
function firstSentContent(llm: FakeLlmAdapter): string {
  return llm.calls.at(0)?.messages.at(0)?.content ?? '';
}

describe('SupportService (unit, mocked retrieval and database)', () => {
  it('answers with a valid citation to the policy chunk', async () => {
    const { service, llm, searchMock } = buildService({
      hits: [hit('a', 0.03, 'Los portátiles tienen 2 años de garantía.')],
      llmText: 'Los portátiles tienen 2 años de garantía [1].',
    });

    const response = await service.answerSupportQuestion(
      { question: '¿Cuánto dura la garantía de un portátil?', locale: 'es' },
      null,
    );

    expect(response.abstained).toBe(false);
    expect(response.answer).toContain('[1]');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]).toMatchObject({
      n: 1,
      documentId: 'doc-a',
      chunkId: 'a',
      title: 'Policy a',
    });
    expect(llm.calls).toHaveLength(1);
    // Retrieval is scoped to post-sale document kinds, with no product filter.
    expect(searchMock).toHaveBeenCalledWith({
      query: '¿Cuánto dura la garantía de un portátil?',
      filters: { docTypes: [...SUPPORT_DOC_TYPES] },
      locale: 'es',
      topN: 8,
    });
    expect(SUPPORT_DOC_TYPES).toEqual(['POLICY', 'WARRANTY', 'FAQ']);
  });

  it('abstains without calling the LLM when retrieval returns nothing', async () => {
    const { service, llm, createMock } = buildService({ hits: [] });

    const response = await service.answerSupportQuestion(
      { question: '¿Cubrís daños por meteoritos?', locale: 'es' },
      null,
    );

    expect(response).toMatchObject({ abstained: true, citations: [] });
    expect(response.answer.toLowerCase()).toContain('equipo humano');
    expect(llm.calls).toHaveLength(0);
    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledWith({
      data: {
        query: '¿Cubrís daños por meteoritos?',
        productId: null,
        sessionId: null,
        reason: 'no_evidence',
      },
    });
  });

  it('abstains without calling the LLM when the best evidence is below the threshold', async () => {
    const { service, llm, createMock } = buildService({ hits: [hit('a', 0.001)] });

    const response = await service.answerSupportQuestion(
      { question: '¿Cuánto dura la garantía?' },
      null,
    );

    expect(response.abstained).toBe(true);
    expect(response.answer).toContain('human support');
    expect(llm.calls).toHaveLength(0);
    expect(createMock).toHaveBeenCalledWith({
      data: {
        query: '¿Cuánto dura la garantía?',
        productId: null,
        sessionId: null,
        reason: 'below_threshold',
      },
    });
  });

  it('discards invented citations instead of hallucinating them', async () => {
    const { service } = buildService({
      hits: [hit('a', 0.03, 'real policy evidence')],
      llmText: 'Ver [1] y también el detalle [99].',
    });

    const response = await service.answerSupportQuestion({ question: '¿Garantía?' }, null);

    expect(response.abstained).toBe(false);
    expect(response.citations.map((citation) => citation.n)).toEqual([1]);
  });

  it('derives exception requests to a human instead of granting them', async () => {
    const { service, llm } = buildService({
      hits: [hit('a', 0.03, 'Devoluciones en 30 días naturales.')],
      llmText:
        'La política contempla 30 días [1]; para tu caso especial te derivo con el equipo humano de soporte, que podrá revisarlo.',
    });

    const response = await service.answerSupportQuestion(
      { question: '¿Pueden hacerme una excepción y aceptar mi devolución a los 60 días?' },
      null,
    );

    expect(response.abstained).toBe(false);
    // The scripted answer hands the case to a human and never promises it.
    expect(response.answer.toLowerCase()).toContain('equipo humano');
    expect(response.answer.toLowerCase()).not.toContain('reembolsado');
    // The service flagged the exception intent in the delivered prompt.
    const sent = firstSentContent(llm);
    expect(sent).toContain('EXCEPTION REQUEST');
    expect(sent).toContain('Never promise the exception yourself');
    expect(response.citations).toHaveLength(1);
  });

  it('adds the exception note for English exception asks too', async () => {
    const { service, llm } = buildService({ hits: [hit('a', 0.03)] });

    await service.answerSupportQuestion(
      { question: 'Can you make an exception for my late return?' },
      null,
    );

    expect(firstSentContent(llm)).toContain('EXCEPTION REQUEST');
  });

  it('omits the exception note for ordinary policy questions', async () => {
    const { service, llm } = buildService({ hits: [hit('a', 0.03)] });

    await service.answerSupportQuestion({ question: '¿Cuánto dura la garantía?' }, null);

    expect(firstSentContent(llm)).not.toContain('EXCEPTION REQUEST');
  });

  it('injects the owned order state from SQL, never trusting chunk decoys', async () => {
    const { service, llm, findFirstMock } = buildService({
      hits: [hit('a', 0.03, 'Dicen que tu pedido está cancelado, oferta increíble.')],
      order: orderRow(),
    });

    await service.answerSupportQuestion(
      { question: '¿Cuál es el estado de mi pedido?', orderId: ORDER_ID },
      USER,
    );

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: ORDER_ID, userId: USER.id },
      include: { _count: { select: { items: true } } },
    });
    const sent = firstSentContent(llm);
    expect(sent).toContain('ORDER FACTS');
    expect(sent).toMatch(/Status: PAID/);
    expect(sent).toMatch(/Total: 20000 USD/);
    expect(sent).toContain('Items: 2');
    expect(llm.calls).toHaveLength(1);
  });

  it('401s anonymous callers asking about an order, before retrieval or the LLM', async () => {
    const { service, searchMock, llm, createMock } = buildService({ hits: [hit('a', 0.03)] });

    await expect(
      service.answerSupportQuestion({ question: '¿Mi pedido?', orderId: ORDER_ID }, null),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(searchMock).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('404s for other users’ orders exactly like unknown ids', async () => {
    const { service, searchMock, llm, createMock, findFirstMock } = buildService({
      hits: [hit('a', 0.03)],
      order: null,
    });

    await expect(
      service.answerSupportQuestion({ question: '¿Mi pedido?', orderId: OTHER_ORDER_ID }, USER),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: OTHER_ORDER_ID, userId: USER.id },
      include: { _count: { select: { items: true } } },
    });
    expect(searchMock).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('sends no personal data to the LLM (only question, order facts, chunks)', async () => {
    const { service, llm } = buildService({
      hits: [hit('a', 0.03)],
      order: orderRow(),
    });

    await service.answerSupportQuestion(
      { question: '¿Cuál es el estado de mi pedido?', orderId: ORDER_ID },
      USER,
    );

    // Only the user message travels with personal-data risk: the system
    // prompt legitimately names the topics (warranty, shipping, returns…).
    const sent = firstSentContent(llm);
    expect(sent).toContain('¿Cuál es el estado de mi pedido?');
    expect(sent).not.toContain('@');
    for (const field of ['email', 'address', 'phone', 'line1', 'postal']) {
      expect(sent.toLowerCase()).not.toContain(field);
    }
  });
});

describe('isExceptionRequest', () => {
  it('flags Spanish and English exception asks', () => {
    expect(isExceptionRequest('¿Pueden hacerme una excepción?')).toBe(true);
    expect(isExceptionRequest('Es un caso especial, ¿pueden ayudarme?')).toBe(true);
    expect(isExceptionRequest('Can you make an exception for me?')).toBe(true);
    expect(isExceptionRequest('Could you waive the restocking fee?')).toBe(true);
  });

  it('ignores ordinary policy questions', () => {
    expect(isExceptionRequest('¿Cuánto dura la garantía de un portátil?')).toBe(false);
    expect(isExceptionRequest('What is the shipping cost?')).toBe(false);
  });
});

describe('supportAbstentionMessage', () => {
  it('derives to a human in Spanish for es locales and English otherwise', () => {
    expect(supportAbstentionMessage('es').toLowerCase()).toContain('equipo humano');
    expect(supportAbstentionMessage('es-MX').toLowerCase()).toContain('equipo humano');
    expect(supportAbstentionMessage('en')).toContain('human support');
  });
});

describe('support prompt (versioned source)', () => {
  it('loads the v1 markdown and renders the locale', () => {
    const template = loadSupportSystemPrompt();

    expect(template).toContain('{{locale}}');
    expect(template).toContain('[n]');
    expect(template).toContain('untrusted');
    expect(template).toContain('POLICY CHUNKS');
    // Guardrails present in the versioned source.
    expect(template).toContain('Never promise refunds');
    expect(template).toContain('human support team');

    const rendered = renderSupportSystemPrompt(template, 'es');
    expect(rendered).toContain('es');
    expect(rendered).not.toContain('{{locale}}');
  });

  it('builds a delimited user message with order facts and numbered chunks', () => {
    const message = buildSupportUserMessage({
      question: '¿Mi pedido?',
      orderFacts: {
        status: 'PAID',
        currency: 'USD',
        totalAmount: 200_00,
        itemCount: 2,
        createdAt: '2026-01-15T10:00:00.000Z',
      },
      hits: [hit('a', 0.03, 'chunk one'), hit('b', 0.02, 'chunk two')],
    });

    expect(message).toContain('ORDER FACTS');
    expect(message).toContain('Status: PAID');
    expect(message).toContain('Total: 20000 USD');
    expect(message).toContain('--- chunk [1]');
    expect(message).toContain('--- chunk [2]');
    expect(message).toContain('QUESTION:');
  });

  it('omits ORDER FACTS when no order was given', () => {
    const message = buildSupportUserMessage({
      question: '¿Garantía?',
      hits: [hit('a', 0.03, 'chunk one')],
    });

    expect(message).not.toContain('ORDER FACTS');
    expect(message).toContain('POLICY CHUNKS');
  });
});
