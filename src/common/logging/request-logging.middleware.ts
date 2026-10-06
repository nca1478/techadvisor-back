import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';

export const REQUEST_ID_HEADER = 'x-request-id';

interface RequestWithId extends Request {
  id?: string;
}

/**
 * Assigns a `requestId` (or reuses the incoming `x-request-id` header),
 * echoes it back in the response, and emits one structured JSON log line per
 * request on finish when `REQUEST_LOGGING_ENABLED` is true.
 * Request/response bodies are never logged.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(req: RequestWithId, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const startedAt = Date.now();
    res.on('finish', () => {
      if (!this.config.REQUEST_LOGGING_ENABLED) {
        return;
      }
      console.log(
        JSON.stringify({
          level: 'log',
          msg: 'request completed',
          requestId,
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      );
    });

    next();
  }
}
