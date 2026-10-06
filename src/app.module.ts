import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RequestLoggingMiddleware } from './common/logging/request-logging.middleware.js';
import { HealthModule } from './modules/health/health.module.js';
import { PublicConfigModule } from './modules/public-config/public-config.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    HealthModule,
    PublicConfigModule,
    AuthModule,
    UsersModule,
    AdminModule,
    CatalogModule,
    InventoryModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Structured JSON logging with requestId for every route (no bodies).
    consumer.apply(RequestLoggingMiddleware).forRoutes('{*path}');
  }
}
