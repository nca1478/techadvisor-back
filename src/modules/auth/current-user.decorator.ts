import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestUser } from './jwt-auth.guard.js';

export type { RequestUser } from './jwt-auth.guard.js';

/** Extracts the `{ id, role }` attached by `JwtAuthGuard`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser => {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    return request['user'] as RequestUser;
  },
);
