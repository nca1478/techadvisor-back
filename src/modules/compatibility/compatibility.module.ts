import { Module } from '@nestjs/common';
import { CompatibilityController } from './compatibility.controller.js';
import { CompatibilityService } from './compatibility.service.js';

/**
 * Deterministic compatibility module (see ADR 0034).
 *
 * Pure `specs`-based rules over SQL-hydrated products — no LLM, no provider
 * SDKs. Exposes `POST /compatibility/check`.
 */
@Module({
  controllers: [CompatibilityController],
  providers: [CompatibilityService],
  exports: [CompatibilityService],
})
export class CompatibilityModule {}
