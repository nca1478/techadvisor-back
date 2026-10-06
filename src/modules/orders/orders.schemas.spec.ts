import { shippingAddressSchema } from './orders.schemas.js';

const BASE = {
  fullName: 'Ada Lovelace',
  line1: 'Calle Mayor 1, 2º B',
  city: 'Madrid',
  country: 'ES',
};

describe('shippingAddressSchema', () => {
  it('accepts a minimal address with only required fields', () => {
    const result = shippingAddressSchema.safeParse(BASE);
    expect(result.success).toBe(true);
  });

  it('accepts all optional fields (region, postalCode, line2, phone)', () => {
    const result = shippingAddressSchema.safeParse({
      ...BASE,
      line2: 'Edificio Norte',
      region: 'Madrid',
      postalCode: '28001',
      phone: '+34 600 123 456',
    });
    expect(result.success).toBe(true);
  });

  it('uppercases the ISO country code', () => {
    const result = shippingAddressSchema.safeParse({ ...BASE, country: 'es' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.country).toBe('ES');
    }
  });

  it('rejects non-ISO-3166-1 country codes', () => {
    for (const country of ['ESP', 'E', 'E1', '12', '']) {
      expect(shippingAddressSchema.safeParse({ ...BASE, country }).success).toBe(false);
    }
  });

  it('rejects missing required fields', () => {
    const cases: Record<string, unknown>[] = ['fullName', 'line1', 'city', 'country'].map((key) => {
      const copy: Record<string, unknown> = { ...BASE };
      // justificado: test-only removal of one required key per case.
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete copy[key];
      return copy;
    });
    for (const body of cases) {
      expect(shippingAddressSchema.safeParse(body).success).toBe(false);
    }
  });
});
