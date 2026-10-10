import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { FakeEmbeddingAdapter } from '../ai/adapters/fake-embedding.adapter.js';
import { FakeLlmAdapter } from '../ai/adapters/fake-llm.adapter.js';
import { AiCallLoggerService } from './ai-call-logger.service.js';
import { LoggingEmbeddingProvider } from './instrumented-embedding.provider.js';
import { LoggingLlmProvider } from './instrumented-llm.provider.js';

const CONFIG = {
  AI_COST_LLM_INPUT_PER_1K: 0,
  AI_COST_LLM_OUTPUT_PER_1K: 0,
  AI_COST_EMBEDDING_PER_1K: 0,
} as unknown as AppConfig;

function buildLogger() {
  const create = vi.fn().mockResolvedValue({ id: 'log-1' });
  const prisma = { aiCallLog: { create } } as unknown as PrismaService;
  const logger = new AiCallLoggerService(prisma, CONFIG);
  return { logger, create };
}

describe('AiCallLoggerService (no PII, no content)', () => {
  it('persists only metadata columns, never prompt/answer text', async () => {
    const { logger, create } = buildLogger();
    const secretQuestion = 'secreto-pii-test@example.com';
    logger.log({
      type: 'LLM',
      provider: 'fake',
      model: 'fake-llm-v1',
      latencyMs: 12,
      status: 'OK',
    });
    // Fire-and-forget uses setImmediate: wait one tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(secretQuestion);
    expect(Object.keys(data).sort()).toEqual(
      [
        'errorCode',
        'estimatedCost',
        'latencyMs',
        'model',
        'provider',
        'sessionId',
        'status',
        'tokensIn',
        'tokensOut',
        'type',
      ].sort(),
    );
  });

  it('never throws when the database write fails', async () => {
    const prisma = {
      aiCallLog: { create: vi.fn().mockRejectedValue(new Error('db down')) },
    } as unknown as PrismaService;
    const logger = new AiCallLoggerService(prisma, CONFIG);
    expect(() => {
      logger.log({ type: 'LLM', provider: 'fake', model: 'm', latencyMs: 1, status: 'OK' });
    }).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('tracks last-known availability without probing providers', () => {
    const { logger } = buildLogger();
    expect(logger.availability()).toBe('unknown');
    logger.log({ type: 'LLM', provider: 'fake', model: 'm', latencyMs: 1, status: 'OK' });
    expect(logger.availability()).toBe('up');
    logger.log({
      type: 'LLM',
      provider: 'fake',
      model: 'm',
      latencyMs: 1,
      status: 'ERROR',
      errorCode: 'server',
    });
    expect(logger.availability()).toBe('degraded');
  });
});

describe('Logging providers (metadata only)', () => {
  it('embedding wrapper logs OK without vectors or texts', async () => {
    const { logger, create } = buildLogger();
    const inner = new FakeEmbeddingAdapter({ dimensions: 8 });
    const provider = new LoggingEmbeddingProvider(inner, logger);
    const vectors = await provider.embed(['texto secreto del usuario']);
    expect(vectors).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).toMatchObject({ type: 'EMBEDDING', status: 'OK' });
    expect(JSON.stringify(data)).not.toContain('texto secreto');
  });

  it('embedding wrapper logs ERROR with code only', async () => {
    const { logger, create } = buildLogger();
    const failing = {
      model: 'm',
      dimensions: 8,
      providerName: 'fake',
      embed: vi.fn().mockRejectedValue(new Error('boom-secret-text')),
    };
    const provider = new LoggingEmbeddingProvider(failing, logger);
    await expect(provider.embed(['hola'])).rejects.toThrow('boom-secret-text');
    await new Promise((resolve) => setImmediate(resolve));
    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).toMatchObject({ type: 'EMBEDDING', status: 'ERROR' });
    // Only the error class name is stored, never the message with content.
    expect(data.errorCode).toBe('Error');
    expect(JSON.stringify(data)).not.toContain('boom-secret-text');
  });

  it('llm wrapper logs usage counts without prompt/answer text', async () => {
    const { logger, create } = buildLogger();
    const inner = new FakeLlmAdapter({ defaultText: 'respuesta con cita [1]' });
    const provider = new LoggingLlmProvider(inner, logger);
    const result = await provider.generate({
      system: 'sistema secreto',
      messages: [{ role: 'user', content: 'pregunta secreta del usuario' }],
    });
    expect(result.text).toContain('respuesta');
    await new Promise((resolve) => setImmediate(resolve));
    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data).toMatchObject({ type: 'LLM', status: 'OK' });
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('pregunta secreta');
    expect(serialized).not.toContain('sistema secreto');
    expect(serialized).not.toContain('respuesta con cita');
  });
});
