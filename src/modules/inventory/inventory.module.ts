import { Global, Module } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';

/**
 * Stock ownership module (global, like PrismaModule): `InventoryService` is
 * the single choke point for every stock mutation in the system (catalog
 * reads availability; carts/orders/admin will mutate through it in later
 * tasks). Intentionally exposes NO controller: there are no public write
 * endpoints for inventory.
 */
@Global()
@Module({
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
