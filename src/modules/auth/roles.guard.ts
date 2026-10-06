import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../../generated/prisma/client.js';
import type { RequestUser } from './jwt-auth.guard.js';
import { ROLES_KEY } from './roles.decorator.js';

/**
 * Authorizes the `request.user` left by `JwtAuthGuard` against the roles
 * declared with `@Roles(...)`. Routes without `@Roles` are allowed through
 * (authentication alone is enough). Order matters: this guard requires
 * `JwtAuthGuard` to have run first.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const user = request['user'] as RequestUser | undefined;
    if (user === undefined || typeof user.id !== 'string') {
      throw new UnauthorizedException('Authentication required');
    }
    if (!required.includes(user.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
