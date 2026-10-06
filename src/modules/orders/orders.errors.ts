import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';

/** Domain error: checkout requires at least one cart line. Surfaces as HTTP 422. */
export class EmptyCartException extends UnprocessableEntityException {
  constructor() {
    super({ message: 'Cannot create an order from an empty cart' });
  }
}

/**
 * Domain error: a cart line references a product that is no longer for sale.
 * Surfaces as HTTP 422 (the request is well-formed; the catalog changed).
 */
export class InactiveProductException extends UnprocessableEntityException {
  constructor(productIds: string[]) {
    super({
      message: `Product(s) no longer available: ${productIds.join(', ')}`,
      details: { productIds },
    });
  }
}

/** Domain error: the order does not exist or belongs to another user (always 404). */
export class OrderNotFoundException extends NotFoundException {
  constructor() {
    super({ message: 'Order not found' });
  }
}
