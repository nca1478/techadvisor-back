import { assembleCartResponse, capMergedQty, type CartLineInput } from './cart.service.js';
import { addCartItemSchema, cartQuerySchema, updateCartItemSchema } from './cart.schemas.js';

function baseProduct() {
  return {
    name: 'Laptop 13',
    slug: 'laptop-13',
    status: 'ACTIVE',
    priceAmount: 129_900,
    currency: 'USD',
    translations: [] as { locale: string; name: string }[],
    images: [{ url: 'https://cdn.example.com/p/front.jpg' }],
    prices: [] as { currency: string; amount: number }[],
  };
}

function line(overrides: Partial<CartLineInput> = {}): CartLineInput {
  return {
    productId: '11111111-1111-4111-8111-111111111111',
    qty: 2,
    product: baseProduct(),
    available: 5,
    ...overrides,
  };
}

describe('assembleCartResponse', () => {
  it('prices lines from the DB rows and sums the total (integers, minor units)', () => {
    const res = assembleCartResponse({
      cartId: 'cart-1',
      locale: 'en',
      currency: 'USD',
      lines: [
        line(),
        line({
          productId: '22222222-2222-4222-8222-222222222222',
          qty: 1,
          product: {
            name: 'Mouse',
            slug: 'mouse',
            status: 'ACTIVE',
            priceAmount: 2_500,
            currency: 'USD',
            translations: [],
            images: [],
            prices: [],
          },
          available: 10,
        }),
      ],
    });
    expect(res.items[0]).toMatchObject({
      name: 'Laptop 13',
      imageUrl: 'https://cdn.example.com/p/front.jpg',
      unitPriceAmount: 129_900,
      qty: 2,
      lineTotalAmount: 259_800,
      inStock: true,
      sufficientStock: true,
    });
    expect(res.items[1]).toMatchObject({
      imageUrl: null,
      unitPriceAmount: 2_500,
      lineTotalAmount: 2_500,
      sufficientStock: true,
    });
    expect(res).toMatchObject({
      currency: 'USD',
      locale: 'en',
      totalAmount: 262_300,
      itemCount: 3,
    });
  });

  it('flags lines whose quantity exceeds the available stock', () => {
    const res = assembleCartResponse({
      cartId: 'cart-1',
      locale: 'en',
      currency: 'USD',
      lines: [line({ qty: 6, available: 5 })],
    });
    expect(res.items[0]).toMatchObject({ inStock: true, sufficientStock: false });
  });

  it('caps the visible available quantity without leaking exact stock', () => {
    const res = assembleCartResponse({
      cartId: 'cart-1',
      locale: 'en',
      currency: 'USD',
      lines: [line({ qty: 1, available: 500 })],
    });
    expect(res.items[0]).toMatchObject({
      inStock: true,
      sufficientStock: true,
      availableQuantity: 10,
    });
  });

  it('marks non-active products as unavailable but still counts their total', () => {
    const res = assembleCartResponse({
      cartId: 'cart-1',
      locale: 'en',
      currency: 'USD',
      lines: [
        line({
          qty: 1,
          available: 5,
          product: { ...baseProduct(), status: 'ARCHIVED' },
        }),
      ],
    });
    expect(res.items[0]).toMatchObject({
      inStock: false,
      sufficientStock: false,
      lineTotalAmount: 129_900,
    });
    expect(res.totalAmount).toBe(129_900);
  });

  it('uses the per-currency override when present, else the base price', () => {
    const withOverride = assembleCartResponse({
      cartId: 'cart-1',
      locale: 'en',
      currency: 'EUR',
      lines: [
        line({
          qty: 1,
          product: {
            ...baseProduct(),
            prices: [{ currency: 'EUR', amount: 119_900 }],
          },
        }),
      ],
    });
    expect(withOverride.items[0]).toMatchObject({ unitPriceAmount: 119_900 });
    expect(withOverride.currency).toBe('EUR');

    const fallback = assembleCartResponse({
      cartId: 'cart-1',
      locale: 'en',
      currency: 'EUR',
      lines: [line({ qty: 1 })],
    });
    expect(fallback.items[0]).toMatchObject({ unitPriceAmount: 129_900 });
    expect(fallback.currency).toBe('EUR');
  });

  it('prefers the translated name when available', () => {
    const res = assembleCartResponse({
      cartId: 'cart-1',
      locale: 'es',
      currency: 'USD',
      lines: [
        line({
          product: { ...baseProduct(), translations: [{ locale: 'es', name: 'Portátil 13' }] },
        }),
      ],
    });
    expect(res.items[0]?.name).toBe('Portátil 13');
  });
});

describe('capMergedQty', () => {
  it('sums guest + user quantities up to the available stock', () => {
    expect(capMergedQty(2, 3, 10)).toBe(5);
    expect(capMergedQty(2, 3, 4)).toBe(4);
    expect(capMergedQty(0, 3, 2)).toBe(2);
  });

  it('resolves to zero when nothing is available (line is dropped)', () => {
    expect(capMergedQty(1, 1, 0)).toBe(0);
  });
});

describe('cart input schemas', () => {
  const productId = '11111111-1111-4111-8111-111111111111';

  it('accepts product + qty, rejects money fields and bad quantities', () => {
    expect(addCartItemSchema.parse({ productId, qty: 1 })).toEqual({ productId, qty: 1 });
    // Unknown keys (e.g. unitPriceAmount/totalAmount) are stripped, never honored.
    expect(addCartItemSchema.parse({ productId, qty: 1, unitPriceAmount: 1 })).toEqual({
      productId,
      qty: 1,
    });
    for (const bad of [
      { productId, qty: 0 },
      { productId, qty: -2 },
      { productId, qty: 1.5 },
      { productId, qty: 1000 },
      { productId: 'not-a-uuid', qty: 1 },
      { qty: 1 },
      { productId },
    ]) {
      expect(addCartItemSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('validates the qty-only update schema', () => {
    expect(updateCartItemSchema.parse({ qty: 3 })).toEqual({ qty: 3 });
    expect(updateCartItemSchema.safeParse({ qty: 0 }).success).toBe(false);
  });

  it('normalizes currency and validates locale in the cart query', () => {
    expect(cartQuerySchema.parse({ currency: 'eur' })).toMatchObject({ currency: 'EUR' });
    expect(cartQuerySchema.safeParse({ currency: 'XX' }).success).toBe(false);
    expect(cartQuerySchema.safeParse({ locale: 'not_a_locale' }).success).toBe(false);
  });
});
