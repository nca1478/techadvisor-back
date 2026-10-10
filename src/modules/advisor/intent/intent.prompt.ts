import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmMessage } from '../../ai/interfaces/llm-provider.interface.js';
import type { BudgetHints } from './budget-parser.js';

/** Version of the intent-extraction system prompt (mirrors `docs/rag/prompts/`). */
export const INTENT_PROMPT_VERSION = 'intent.v1';

export const INTENT_PLACEHOLDERS = [
  '{{locale}}',
  '{{baseCurrency}}',
  '{{currencies}}',
  '{{categories}}',
  '{{specKeys}}',
] as const;

let cachedTemplate: string | null = null;

/**
 * Loads the versioned intent system prompt from
 * `backend/docs/rag/prompts/intent.v1.md` — the single source of truth
 * (see ADR 0031). Resolved relative to this file so it works both from
 * `src/` (dev/tests) and `dist/` (production build). Throws at boot when
 * the file is missing instead of extracting with a fallback prompt.
 */
export function loadIntentSystemPrompt(): string {
  if (cachedTemplate !== null) {
    return cachedTemplate;
  }
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../docs/rag/prompts/intent.v1.md',
  );
  cachedTemplate = readFileSync(path, 'utf8');
  return cachedTemplate;
}

/** Clears the cached template (tests only). */
export function resetIntentSystemPromptCache(): void {
  cachedTemplate = null;
}

/** Replaces every `{{placeholder}}` with the request context. Pure, unit-testable. */
export function renderIntentSystemPrompt(
  template: string,
  context: {
    locale: string;
    baseCurrency: string;
    currencies: readonly string[];
    categories: readonly string[];
    specKeys: readonly string[];
  },
): string {
  return template
    .replaceAll('{{locale}}', context.locale)
    .replaceAll('{{baseCurrency}}', context.baseCurrency)
    .replaceAll('{{currencies}}', context.currencies.join(', '))
    .replaceAll('{{categories}}', context.categories.join(', '))
    .replaceAll('{{specKeys}}', context.specKeys.join(', '));
}

export interface IntentConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Builds the single user message: numbered conversation turns (oldest
 * first) plus the deterministic DETECTED BUDGET block when the parser found
 * one, plus reference lists. Pure and unit-testable. No personal data may
 * be passed in — callers only supply conversation text and the parser hint.
 */
export function buildIntentUserMessage(options: {
  turns: readonly IntentConversationTurn[];
  budget: BudgetHints;
  locale: string;
  currency: string;
}): string {
  const lines: string[] = [];
  lines.push('CONVERSATION (oldest first; only USER turns carry constraints):');
  options.turns.forEach((turn, index) => {
    const speaker = turn.role === 'user' ? 'USER' : 'ASSISTANT';
    lines.push(`[${String(index + 1)}] ${speaker}: ${turn.content}`);
  });
  lines.push('');
  if (options.budget.maxPrice !== undefined || options.budget.minPrice !== undefined) {
    lines.push('DETECTED BUDGET (deterministic parse, minor units — copy it verbatim):');
    if (options.budget.maxPrice !== undefined) {
      lines.push(
        `- maxPrice: ${String(options.budget.maxPrice.amount)} ${options.budget.maxPrice.currency}`,
      );
    }
    if (options.budget.minPrice !== undefined) {
      lines.push(
        `- minPrice: ${String(options.budget.minPrice.amount)} ${options.budget.minPrice.currency}`,
      );
    }
  } else {
    lines.push('DETECTED BUDGET: none (only set a budget when the user stated one).');
  }
  lines.push('');
  lines.push(`Locale: ${options.locale}. Default currency when unstated: ${options.currency}.`);
  lines.push('Extract the purchase constraints as a JSON object.');
  return lines.join('\n');
}

/** Keeps the last N turns so one extraction can never cost an unbounded prompt. */
export function truncateIntentTurns(
  messages: readonly LlmMessage[],
  maxTurns = 10,
): IntentConversationTurn[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-maxTurns)
    .map((message) => ({ role: message.role, content: message.content.trim().slice(0, 2000) }));
}
