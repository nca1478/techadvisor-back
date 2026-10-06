import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { PasswordService } from './password.service.js';

/**
 * Shared security primitives: JWT wiring, guards and password hashing.
 * Imported by `UsersModule`, `AuthModule` and `AdminModule` — it depends
 * only on the global config and `@nestjs/jwt`, so the graph stays acyclic
 * (no AuthModule <-> UsersModule cycle).
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.JWT_SECRET,
        signOptions: { expiresIn: config.JWT_ACCESS_EXPIRES_IN_SEC },
      }),
    }),
  ],
  providers: [JwtAuthGuard, RolesGuard, PasswordService],
  exports: [JwtModule, JwtAuthGuard, RolesGuard, PasswordService],
})
export class AuthSecurityModule {}
