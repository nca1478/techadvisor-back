import { Module } from '@nestjs/common';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersExpirationService } from './orders-expiration.service.js';
import { OrdersService } from './orders.service.js';

/**
 * Customer checkout from the user cart (see ADR 0011). `InventoryService` is
 * global; `AuthSecurityModule` provides the JWT guard. Stock side effects go
 * through conditional `UPDATE`s inside the order transaction — the single
 * choke point stays `InventoryService` for read/standalone operations.
 */
@Module({
  imports: [AuthSecurityModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersExpirationService],
  exports: [OrdersService],
})
export class OrdersModule {}
