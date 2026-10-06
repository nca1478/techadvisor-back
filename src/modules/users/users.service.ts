import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PasswordService } from '../auth/password.service.js';
import type { Role } from '../../generated/prisma/client.js';

/** Public user shape — never includes `passwordHash`. */
export interface SafeUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export function toSafeUser(user: {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * User persistence. Password hashing lives here so every creation path
 * hashes; `findByEmailWithHash` exists only for the login check inside
 * `AuthService` and must never be exposed through a controller.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async create(input: { email: string; password: string; name?: string }): Promise<SafeUser> {
    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.prisma.user.create({
      data: {
        // Public sign-up always creates CUSTOMER; ADMIN is granted
        // out-of-band (seed/scripts), never from request input.
        email: input.email,
        passwordHash,
        name: input.name,
        role: 'CUSTOMER',
      },
    });
    return toSafeUser(user);
  }

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? toSafeUser(user) : null;
  }

  async findByEmail(email: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    return user ? toSafeUser(user) : null;
  }

  /** Internal: full row including `passwordHash`, for the login check only. */
  async findByEmailWithHash(email: string): Promise<{
    id: string;
    email: string;
    name: string | null;
    role: Role;
    createdAt: Date;
    updatedAt: Date;
    passwordHash: string;
  } | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        passwordHash: true,
      },
    });
  }
}
