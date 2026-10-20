import { CanActivate, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';

/**
 * Storefront AI kill-switch (see ADR ai-enabled).
 *
 * When `AI_ENABLED=false`, the public advisor surface (product-QA, compare,
 * support, chat sessions, feedback) answers `403 FORBIDDEN` with a stable
 * message instead of calling retrieval/LLM. Admin endpoints never use this
 * guard. The frontend also hides the UI from `GET /config/public`, so this
 * guard is the server-side safety net (never trust the client).
 */
@Injectable()
export class AiEnabledGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(): boolean {
    if (this.config.AI_ENABLED) {
      return true;
    }
    throw new ForbiddenException('AI features are disabled');
  }
}
