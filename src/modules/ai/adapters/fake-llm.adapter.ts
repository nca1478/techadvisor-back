import type {
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmProvider,
} from '../interfaces/llm-provider.interface.js';

/**
 * Programmable fake LLM adapter — tests and offline development ONLY.
 *
 * Responses are scripted per test: either a queue consumed in order, a
 * lookup by the last user message, or a static default. Every call is
 * recorded in `calls` (metadata only — the recorded requests ARE the
 * prompts, so tests must treat `calls` as sensitive and assert on counts
 * or roles, never log them). No network, no secrets, no input logging.
 */
export class FakeLlmAdapter implements LlmProvider {
  readonly providerName = 'fake';
  readonly model: string;

  /** Every generate/stream request received, in order. */
  readonly calls: LlmGenerateRequest[] = [];

  private readonly queue: string[] = [];
  private readonly byLastUserMessage = new Map<string, string>();
  private defaultText: string;

  constructor(options: { model?: string; defaultText?: string } = {}) {
    this.model = options.model ?? 'fake-llm-v1';
    this.defaultText = options.defaultText ?? 'fake response';
  }

  /** Next generate()/stream() calls resolve with these texts, in order. */
  enqueueTexts(texts: string[]): void {
    this.queue.push(...texts);
  }

  /** Replies with `text` when the last user message equals `userMessage`. */
  setTextFor(userMessage: string, text: string): void {
    this.byLastUserMessage.set(userMessage, text);
  }

  setDefaultText(text: string): void {
    this.defaultText = text;
  }

  generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    this.calls.push(req);
    return Promise.resolve({ text: this.nextText(req), latencyMs: 0 });
  }

  async *stream(req: LlmGenerateRequest): AsyncIterable<string> {
    this.calls.push(req);
    // Yield word-sized deltas so consumers exercise concatenation. The await
    // keeps this an async generator (streaming shape) without real I/O.
    await Promise.resolve();
    for (const word of this.nextText(req).split(' ')) {
      yield word === '' ? '' : `${word} `;
    }
  }

  private nextText(req: LlmGenerateRequest): string {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    const lastUser = [...req.messages].reverse().find((message) => message.role === 'user');
    if (lastUser !== undefined) {
      const scripted = this.byLastUserMessage.get(lastUser.content);
      if (scripted !== undefined) {
        return scripted;
      }
    }
    return this.defaultText;
  }
}
