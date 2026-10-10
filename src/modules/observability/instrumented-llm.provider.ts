import { AiProviderError } from '../ai/ai-provider.error.js';
import type {
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmProvider,
} from '../ai/interfaces/llm-provider.interface.js';
import type { AiCallLoggerService } from './ai-call-logger.service.js';
import { normalizeErrorCode } from './instrumented-embedding.provider.js';

/**
 * LLM provider decorator (see ADR 0039): delegates to the configured adapter
 * and logs one metadata-only row per `generate()`/`stream()` call without
 * blocking the response. Token counts come from the adapter-reported `usage`
 * only; prompts and completions never reach the logger.
 */
export class LoggingLlmProvider implements LlmProvider {
  readonly providerName: string;
  readonly model: string;

  constructor(
    private readonly inner: LlmProvider,
    private readonly logger: AiCallLoggerService,
  ) {
    this.providerName = inner.providerName;
    this.model = inner.model;
  }

  async generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const startedAt = Date.now();
    try {
      const result = await this.inner.generate(req);
      this.logger.log({
        type: 'LLM',
        provider: this.providerName,
        model: this.model,
        // Prefer the adapter-measured latency; fall back to wall clock.
        latencyMs: result.latencyMs || Date.now() - startedAt,
        ...(result.usage !== undefined ? { tokensIn: result.usage.inputTokens } : {}),
        ...(result.usage !== undefined ? { tokensOut: result.usage.outputTokens } : {}),
        status: 'OK',
      });
      return result;
    } catch (error) {
      this.logger.log({
        type: 'LLM',
        provider: this.providerName,
        model: this.model,
        latencyMs: Date.now() - startedAt,
        status: 'ERROR',
        errorCode: error instanceof AiProviderError ? error.code : normalizeErrorCode(error),
      });
      throw error;
    }
  }

  async *stream(req: LlmGenerateRequest): AsyncIterable<string> {
    const startedAt = Date.now();
    try {
      yield* this.inner.stream(req);
      this.logger.log({
        type: 'LLM',
        provider: this.providerName,
        model: this.model,
        latencyMs: Date.now() - startedAt,
        status: 'OK',
      });
    } catch (error) {
      this.logger.log({
        type: 'LLM',
        provider: this.providerName,
        model: this.model,
        latencyMs: Date.now() - startedAt,
        status: 'ERROR',
        errorCode: error instanceof AiProviderError ? error.code : normalizeErrorCode(error),
      });
      throw error;
    }
  }
}
