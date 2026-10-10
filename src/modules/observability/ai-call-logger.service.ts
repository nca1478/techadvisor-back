import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Kind of instrumented call (mirrors the `AiCallType` enum). */
export type AiCallType = 'EMBEDDING' | 'LLM' | 'RETRIEVAL';

/** Outcome of one instrumented call (mirrors `AiCallStatus`). */
export type AiCallStatus = 'OK' | 'ERROR';

/** Metadata-only entry: never carries prompts, questions or answers. */
export interface AiCallLogEntry {
  type: AiCallType;
  provider: string;
  model: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  status: AiCallStatus;
  /** Normalized error code (`AiErrorCode` or class name); undefined on OK. */
  errorCode?: string;
  /** Owning chat session id when known; never user content. */
  sessionId?: string;
}

/** Last known provider state for the healthcheck (no live probe). */
export interface AiProviderState {
  provider: string;
  model: string;
  status: AiCallStatus;
  errorCode?: string;
  at: string;
}

/**
 * Metadata-only AI call logger (see ADR 0039).
 *
 * `log()` is fire-and-forget by design: it schedules the INSERT with
 * `setImmediate` and never rejects, so instrumented request paths never
 * block on observability and a logging failure can never fail a user
 * request. Only the fixed columns above are persisted — the signature makes
 * it type-impossible to pass prompt/response content.
 *
 * The in-memory `lastStateByProvider` map feeds the extended healthcheck:
 * availability is reported from the last known outcome, never from a live
 * provider call per healthcheck.
 */
@Injectable()
export class AiCallLoggerService {
  private readonly logger = new Logger(AiCallLoggerService.name);
  private readonly lastState = new Map<string, AiProviderState>();

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
  ) {}

  /** Queue one metadata row without blocking the caller. Never throws. */
  log(entry: AiCallLogEntry): void {
    this.recordState(entry);
    const cost = this.estimateCost(entry);
    // setImmediate keeps the INSERT off the request path; `void` plus the
    // inner catch guarantees no unhandled rejection can escape.
    setImmediate(() => {
      if (this.prisma === undefined) {
        return;
      }
      void this.prisma.aiCallLog
        .create({
          data: {
            type: entry.type,
            provider: entry.provider.slice(0, 120),
            model: entry.model.slice(0, 200),
            latencyMs: Math.max(0, Math.round(entry.latencyMs)),
            tokensIn: entry.tokensIn,
            tokensOut: entry.tokensOut,
            estimatedCost: cost,
            status: entry.status,
            errorCode: entry.errorCode?.slice(0, 120),
            sessionId: entry.sessionId?.slice(0, 200),
          },
        })
        .catch((error: unknown) => {
          // Metadata only: never the entry (it holds no content anyway).
          this.logger.warn(
            `ai-call-log write failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`,
          );
        });
    });
  }

  /** Last known outcome per provider key (`provider/model`), newest first. */
  lastKnownStates(limit = 10): AiProviderState[] {
    return [...this.lastState.values()].slice(-limit);
  }

  /** Overall AI availability from the last known outcomes (no live probe). */
  availability(): 'up' | 'degraded' | 'unknown' {
    if (this.lastState.size === 0) {
      return 'unknown';
    }
    for (const state of this.lastState.values()) {
      if (state.status === 'ERROR') {
        return 'degraded';
      }
    }
    return 'up';
  }

  private recordState(entry: AiCallLogEntry): void {
    this.lastState.set(`${entry.type}/${entry.provider}/${entry.model}`, {
      provider: entry.provider,
      model: entry.model,
      status: entry.status,
      ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
      at: new Date().toISOString(),
    });
    // Bound memory: keep only the most recent entries.
    if (this.lastState.size > 50) {
      const first = this.lastState.keys().next();
      if (!first.done) {
        this.lastState.delete(first.value);
      }
    }
  }

  /**
   * Telemetry-only USD estimate from the optional per-1k-token tariffs.
   * Returns undefined (stored as NULL) when tariffs are unset (0) or when
   * token counts are unknown. Never billing (see ADR 0039).
   */
  private estimateCost(entry: AiCallLogEntry): number | undefined {
    const tariffs = this.config;
    if (tariffs === undefined) {
      return undefined;
    }
    if (entry.type === 'EMBEDDING') {
      const per1k = tariffs.AI_COST_EMBEDDING_PER_1K;
      const tokens = (entry.tokensIn ?? 0) + (entry.tokensOut ?? 0);
      if (per1k <= 0 || tokens <= 0) {
        return undefined;
      }
      return (tokens / 1000) * per1k;
    }
    if (entry.type === 'LLM') {
      const inRate = tariffs.AI_COST_LLM_INPUT_PER_1K;
      const outRate = tariffs.AI_COST_LLM_OUTPUT_PER_1K;
      if (inRate <= 0 && outRate <= 0) {
        return undefined;
      }
      const tokensIn = entry.tokensIn ?? 0;
      const tokensOut = entry.tokensOut ?? 0;
      if (tokensIn <= 0 && tokensOut <= 0) {
        return undefined;
      }
      return (tokensIn / 1000) * inRate + (tokensOut / 1000) * outRate;
    }
    return undefined;
  }
}
