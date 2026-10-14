import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PAYMENT_PROVIDER } from './payment-provider.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { StripePaymentProvider } from './stripe-payment.provider.js';

/**
 * Stripe test-mode payments behind the `PaymentProvider` interface (ADR
 * 0012). `OrdersModule` supplies the guarded order transitions (stock
 * side effects included); `AuthSecurityModule` supplies the JWT guard for
 * `/payments/checkout`. The webhook route stays public by design — Stripe
 * authenticates it with the webhook signature, not with our JWT.
 */
@Module({
  imports: [AuthSecurityModule, OrdersModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new StripePaymentProvider({
          secretKey: config.STRIPE_SECRET_KEY,
          webhookSecret: config.STRIPE_WEBHOOK_SECRET,
          baseUrl: config.STRIPE_BASE_URL,
        }),
    },
  ],
})
export class PaymentsModule {}
