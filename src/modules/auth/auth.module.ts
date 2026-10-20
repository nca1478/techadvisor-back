import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { MailModule } from '../mail/mail.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthSecurityModule } from './auth-security.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GoogleIdTokenVerifier } from './google-id-token.verifier.js';
import { PasswordResetController } from './password-reset.controller.js';
import { PasswordResetService } from './password-reset.service.js';

@Module({
  imports: [
    UsersModule,
    AuthSecurityModule,
    MailModule,
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
        // Named throttler consumed by the product-QA advisor (which skips
        // the `auth` and `search` throttlers). Same single-forRoot rule.
        {
          name: 'advisor',
          ttl: config.ADVISOR_RATE_LIMIT_TTL_MS,
          limit: config.ADVISOR_RATE_LIMIT_MAX,
        },
      ],
    }),
  ],
  controllers: [AuthController, PasswordResetController],
  providers: [AuthService, PasswordResetService, GoogleIdTokenVerifier],
})
export class AuthModule {}
