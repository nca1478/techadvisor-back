import { SetMetadata } from '@nestjs/common';
import type { Role } from '../../generated/prisma/client.js';

export const ROLES_KEY = 'techadvisor:roles';

/**
 * Declares the roles allowed on a route/class. Enforcement happens in
 * `RolesGuard`, which must run after `JwtAuthGuard`:
 * `@UseGuards(JwtAuthGuard, RolesGuard)`.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
