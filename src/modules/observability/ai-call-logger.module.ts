import { Module } from '@nestjs/common';
import { AiCallLoggerService } from './ai-call-logger.service.js';

/**
 * Minimal logger module (see ADR 0039): exports `AiCallLoggerService`
 * (metadata-only `ai_call_logs` writes, fire-and-forget) without importing
 * `AiModule`, so `AiModule` can depend on it to wrap the configured
 * providers without a circular import.
 */
@Module({
  providers: [AiCallLoggerService],
  exports: [AiCallLoggerService],
})
export class AiCallLoggerModule {}
