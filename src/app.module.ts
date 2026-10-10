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
import { CartModule } from './modules/cart/cart.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { IngestionModule } from './modules/ingestion/ingestion.module.js';
import { ReindexModule } from './modules/reindex/reindex.module.js';
import { RetrievalModule } from './modules/retrieval/retrieval.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { AdvisorModule } from './modules/advisor/advisor.module.js';
import { CompatibilityModule } from './modules/compatibility/compatibility.module.js';
import { ReviewsModule } from './modules/reviews/reviews.module.js';
import { ObservabilityModule } from './modules/observability/observability.module.js';

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
    CartModule,
    OrdersModule,
    PaymentsModule,
    AiModule,
    IngestionModule,
    ReindexModule,
    RetrievalModule,
    SearchModule,
    AdvisorModule,
    CompatibilityModule,
    ReviewsModule,
    ObservabilityModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Structured JSON logging with requestId for every route (no bodies).
    consumer.apply(RequestLoggingMiddleware).forRoutes('{*path}');
  }
}
