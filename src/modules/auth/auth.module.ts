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
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
