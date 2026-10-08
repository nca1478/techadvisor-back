import { Module } from '@nestjs/common';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

/**
 * Back-office writes (Fase 1, P1.7 — see ADR 0013). Imports
 * `OrdersModule` for the guarded `OrdersService.transitionOrder` (the
 * state machine stays enforced in one place); `InventoryService` is
 * global but stock adjustments live here because they must append the
 * `InventoryMovement` audit row in the same transaction.
 */
@Module({
  imports: [AuthSecurityModule, OrdersModule, IngestionModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
