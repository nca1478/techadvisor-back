import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RequestLoggingMiddleware } from './common/logging/request-logging.middleware.js';
import { HealthModule } from './modules/health/health.module.js';
import { PublicConfigModule } from './modules/public-config/public-config.module.js';

@Module({
  imports: [AppConfigModule, PrismaModule, HealthModule, PublicConfigModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Structured JSON logging with requestId for every route (no bodies).
    consumer.apply(RequestLoggingMiddleware).forRoutes('*');
  }
}
