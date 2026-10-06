import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { RequestUser } from '../auth/jwt-auth.guard.js';

/**
 * Optional authentication for cart endpoints, which serve both guests and
 * logged-in users. When a valid `Authorization: Bearer <access-jwt>` header
 * is present, `{ id, role }` is attached to the request exactly like
 * `JwtAuthGuard` does; when it is absent or invalid the request continues
 * anonymously (guest path via the `sid` cookie) instead of 401ing.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> } & Record<string, unknown>>();
    const header = request.headers['authorization'];
    const [scheme, token] = typeof header === 'string' ? header.split(' ') : [];

    if (scheme !== 'Bearer' || typeof token !== 'string' || token.length === 0) {
      return true;
    }
    try {
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.JWT_SECRET,
      });
      if (
        typeof payload['sub'] === 'string' &&
        (payload['role'] === 'CUSTOMER' || payload['role'] === 'ADMIN')
      ) {
        const user: RequestUser = { id: payload['sub'], role: payload['role'] };
        request['user'] = user;
      }
    } catch {
      // Invalid/expired token on a cart route: stay anonymous (guest cart).
    }
    return true;
  }
}

/** Reads the optional user attached by `OptionalJwtAuthGuard` (or null). */
export function getOptionalUser(request: Record<string, unknown>): RequestUser | null {
  const user = request['user'] as RequestUser | undefined;
  // `RequestUser` already constrains the role; only the id needs checking.
  return typeof user?.id === 'string' ? user : null;
}

/** Like `getOptionalUser` but 401s when anonymous (for `POST /cart/merge`). */
export function requireUser(request: Record<string, unknown>): RequestUser {
  const user = getOptionalUser(request);
  if (user === null) {
    throw new UnauthorizedException('Authentication required');
  }
  return user;
}
