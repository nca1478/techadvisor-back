import { BadRequestException, ConflictException } from '@nestjs/common';

/** Single line of a multi-product stock operation. */
export interface StockItem {
  productId: string;
  qty: number;
}

/**
 * Domain error: the requested quantity exceeds what is available
 * (`stock - reserved`). Surfaces as HTTP 409 with the uniform payload.
 */
export class InsufficientStockException extends ConflictException {
  constructor(productIds: string[]) {
    super({
      message: `Insufficient stock for product(s): ${productIds.join(', ')}`,
      details: { productIds },
    });
  }
}

/**
 * Domain error: quantities must be positive integers. Surfaces as HTTP 400.
 */
export class InvalidQuantityException extends BadRequestException {
  constructor(message: string) {
    super({ message });
  }
}
