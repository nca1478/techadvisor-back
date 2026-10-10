import { Module } from '@nestjs/common';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { AiCallLoggerModule } from './ai-call-logger.module.js';
import { ObservabilityController } from './observability.controller.js';
import { ObservabilityService } from './observability.service.js';

/**
 * Operational observability module (see ADR 0039).
 *
 * Owns the admin-only `GET /metrics` (Prometheus text without new
 * dependencies) and the `POST /metrics/cleanup` retention trigger for the
 * metadata-only `ai_call_logs`. `AuthSecurityModule` provides the JWT
 * primitives; the ADMIN role guard lives on the controller like every other
 * back-office route. Queue depths are probed on demand with short-lived
 * BullMQ connections (never a persistent worker in the API process).
 */
@Module({
  imports: [AiCallLoggerModule, AuthSecurityModule],
  controllers: [ObservabilityController],
  providers: [ObservabilityService],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
