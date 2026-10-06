import { InvalidOrderTransitionException } from './order-status.js';
import { PENDING_ORDER_TTL_MS, OrdersExpirationService } from './orders-expiration.service.js';
import type { OrdersService } from './orders.service.js';

function createHarness() {
  const orders = {
    findExpiredPendingOrderIds: vi.fn(),
    transitionOrder: vi.fn(),
  };
  const service = new OrdersExpirationService(orders as unknown as OrdersService);
  return { service, orders };
}

describe('OrdersExpirationService', () => {
  it('expires candidates older than the 30-minute TTL', async () => {
    expect(PENDING_ORDER_TTL_MS).toBe(30 * 60 * 1000);
    const { service, orders } = createHarness();
    orders.findExpiredPendingOrderIds.mockResolvedValue(['order-1', 'order-2']);
    orders.transitionOrder.mockResolvedValue(undefined);

    const now = new Date('2026-10-06T12:00:00.000Z');
    await expect(service.expirePendingOrders(now)).resolves.toBe(2);
    expect(orders.findExpiredPendingOrderIds).toHaveBeenCalledWith(
      new Date('2026-10-06T11:30:00.000Z'),
      100,
    );
    expect(orders.transitionOrder).toHaveBeenCalledWith('order-1', 'CANCELLED');
    expect(orders.transitionOrder).toHaveBeenCalledWith('order-2', 'CANCELLED');
  });

  it('skips orders that changed state concurrently instead of failing the sweep', async () => {
    const { service, orders } = createHarness();
    orders.findExpiredPendingOrderIds.mockResolvedValue(['order-1', 'order-2']);
    orders.transitionOrder
      .mockRejectedValueOnce(new InvalidOrderTransitionException('PAID', 'CANCELLED'))
      .mockResolvedValueOnce(undefined);

    await expect(service.expirePendingOrders()).resolves.toBe(1);
  });

  it('does nothing when no order is expired', async () => {
    const { service, orders } = createHarness();
    orders.findExpiredPendingOrderIds.mockResolvedValue([]);

    await expect(service.expirePendingOrders()).resolves.toBe(0);
    expect(orders.transitionOrder).not.toHaveBeenCalled();
  });
});
