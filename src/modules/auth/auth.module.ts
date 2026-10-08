import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { UsersModule } from '../users/users.module.js';
import { AuthSecurityModule } from './auth-security.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  imports: [
    UsersModule,
    AuthSecurityModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => [
        {
          name: 'auth',
          ttl: config.AUTH_RATE_LIMIT_TTL_MS,
          limit: config.AUTH_RATE_LIMIT_MAX,
        },
        // Named throttler consumed by the public search endpoint (which
        // skips the `auth` throttler). Registered here because there is a
        // single ThrottlerModule.forRoot in the app (see ADR 0022).
        {
          name: 'search',
          ttl: config.SEARCH_RATE_LIMIT_TTL_MS,
          limit: config.SEARCH_RATE_LIMIT_MAX,
        },
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
