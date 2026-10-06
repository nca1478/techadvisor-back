import { Module } from '@nestjs/common';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard.js';

/**
 * Guest + authenticated carts (see ADR 0010). `InventoryService` is global;
 * `AuthSecurityModule` provides the JWT primitives for the optional/required
 * guards. No stock reservation happens here — only read-only availability
 * checks.
 */
@Module({
  imports: [AuthSecurityModule],
  controllers: [CartController],
  providers: [CartService, OptionalJwtAuthGuard],
})
export class CartModule {}
