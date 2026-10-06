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
import type { Role } from '../../generated/prisma/client.js';

export interface RequestUser {
  id: string;
  role: Role;
}

/**
 * Authenticates `Authorization: Bearer <access-jwt>` and attaches
 * `{ id, role }` to the request. No passport dependency by design (ADR
 * 0005): fewer moving parts, fully unit-testable. Tokens and credentials
 * are never logged.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
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
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    let payload: unknown;
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.config.JWT_SECRET });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = toRequestUser(payload);
    if (user === null) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    request['user'] = user;
    return true;
  }
}

function toRequestUser(payload: unknown): RequestUser | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record['sub'] !== 'string' || record['sub'].length === 0) {
    return null;
  }
  if (record['role'] !== 'CUSTOMER' && record['role'] !== 'ADMIN') {
    return null;
  }
  return { id: record['sub'], role: record['role'] };
}
