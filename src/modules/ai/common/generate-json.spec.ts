import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { FakeLlmAdapter } from '../adapters/fake-llm.adapter.js';
import { LlmJsonError, generateJson } from './generate-json.js';

const REQ = { system: 'Extract.', messages: [{ role: 'user' as const, content: 'laptop, 800' }] };

const BudgetSchema = z.object({ budget: z.number(), category: z.string() });

describe('generateJson', () => {
  it('returns parsed data on the first try without a retry', async () => {
    const provider = new FakeLlmAdapter();
    provider.enqueueTexts(['{"budget":800,"category":"laptop"}']);

    const result = await generateJson(provider, BudgetSchema, REQ);

    expect(result).toEqual({ data: { budget: 800, category: 'laptop' }, attempts: 1 });
    expect(provider.calls).toHaveLength(1);
  });

  it('strips ```json fences before parsing', async () => {
    const provider = new FakeLlmAdapter();
    provider.enqueueTexts(['```json\n{"budget":800,"category":"laptop"}\n```']);

    const result = await generateJson(provider, BudgetSchema, REQ);

    expect(result.attempts).toBe(1);
    expect(result.data).toEqual({ budget: 800, category: 'laptop' });
  });

  it('retries once with a correction message after invalid JSON, then succeeds', async () => {
    const provider = new FakeLlmAdapter();
    provider.enqueueTexts(['not json at all', '{"budget":800,"category":"laptop"}']);

    const result = await generateJson(provider, BudgetSchema, REQ);

    expect(result.attempts).toBe(2);
    expect(result.data).toEqual({ budget: 800, category: 'laptop' });
    expect(provider.calls).toHaveLength(2);
    const correction = provider.calls[1]?.messages.at(-1);
    expect(correction?.role).toBe('user');
    expect(correction?.content).toContain('not valid JSON');
  });

  it('retries once after schema mismatch and reports the field issue', async () => {
    const provider = new FakeLlmAdapter();
    provider.enqueueTexts([
      '{"budget":"a lot","category":"laptop"}',
      '{"budget":800,"category":"laptop"}',
    ]);

    const result = await generateJson(provider, BudgetSchema, REQ);

    expect(result.attempts).toBe(2);
    expect(provider.calls[1]?.messages.at(-1)?.content).toContain('budget');
  });

  it('throws a typed error after the retry is consumed', async () => {
    const provider = new FakeLlmAdapter();
    provider.enqueueTexts(['garbage one', 'garbage two']);

    const error = await generateJson(provider, BudgetSchema, REQ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmJsonError);
    expect((error as LlmJsonError).attempts).toBe(2);
    expect((error as LlmJsonError).issues).toHaveLength(1);
    expect((error as LlmJsonError).message).toMatch(/one correction retry/i);
    expect(provider.calls).toHaveLength(2);
  });
});
