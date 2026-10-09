import type { z } from 'zod';
import type { LlmGenerateRequest, LlmProvider } from '../interfaces/llm-provider.interface.js';

/**
 * Typed error for structured-output failures (see ADR 0024).
 *
 * Thrown ONLY after the single allowed correction retry has been consumed.
 * Carries the Zod issues and the raw outputs' lengths — never prompt text,
 * never secrets — so callers can log/abstain without leaking content.
 */
export class LlmJsonError extends Error {
  readonly attempts: number;
  readonly issues: string[];

  constructor(message: string, options: { attempts: number; issues: string[] }) {
    super(message);
    this.name = 'LlmJsonError';
    this.attempts = options.attempts;
    this.issues = options.issues;
  }
}

export interface GenerateJsonResult<T> {
  data: T;
  /** Attempts consumed (1 = first try parsed, 2 = correction retry parsed). */
  attempts: number;
}

/**
 * Provider-neutral structured output: asks the model for JSON, validates
 * with Zod, and retries ONCE with a correction message listing the
 * validation issues. Works with any `LlmProvider` — no tool-calling, no
 * response-format flags, no provider-exclusive features.
 *
 * The model is instructed (neutral wording) to reply with ONLY the JSON
 * object. Fences (```json ... ```) are stripped before parsing.
 */
export async function generateJson<T>(
  provider: LlmProvider,
  schema: z.ZodType<T>,
  req: LlmGenerateRequest,
): Promise<GenerateJsonResult<T>> {
  const first = await provider.generate({
    ...req,
    system: `${req.system}\nReply with ONLY a valid JSON object, no prose, no code fences.`,
  });
  const firstParsed = tryParseAndValidate(schema, first.text);
  if (firstParsed.success) {
    return { data: firstParsed.data, attempts: 1 };
  }

  const correction: LlmGenerateRequest = {
    system: req.system,
    temperature: req.temperature,
    maxTokens: req.maxTokens,
    messages: [
      ...req.messages,
      { role: 'assistant', content: first.text },
      {
        role: 'user',
        content:
          `Your previous response was not valid JSON or did not match the required schema. ` +
          `Issues: ${firstParsed.issues.join('; ')}. ` +
          `Reply with ONLY the corrected JSON object, no prose, no code fences.`,
      },
    ],
  };
  const second = await provider.generate(correction);
  const secondParsed = tryParseAndValidate(schema, second.text);
  if (secondParsed.success) {
    return { data: secondParsed.data, attempts: 2 };
  }
  throw new LlmJsonError('Model did not return valid JSON after one correction retry', {
    attempts: 2,
    issues: secondParsed.issues,
  });
}

function tryParseAndValidate<T>(
  schema: z.ZodType<T>,
  raw: string,
): { success: true; data: T } | { success: false; issues: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return { success: false, issues: ['response is not valid JSON'] };
  }
  const result = schema.safeParse(parsed);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    }),
  };
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}
