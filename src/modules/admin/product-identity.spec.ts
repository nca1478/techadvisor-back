import { describe, expect, it } from 'vitest';
import {
  generateSkuCandidate,
  generateSlugCandidate,
  isGeneratedSku,
  slugifyProductName,
} from './product-identity.js';

describe('product-identity (SKU/slug generation)', () => {
  it('generates TA-XXXXXX SKUs starting with a letter and containing a digit', () => {
    for (let i = 0; i < 50; i += 1) {
      const sku = generateSkuCandidate();
      expect(isGeneratedSku(sku)).toBe(true);
      expect(sku.startsWith('TA-')).toBe(true);
      expect(/\d/.test(sku)).toBe(true);
      expect(sku.length).toBeLessThanOrEqual(32);
    }
  });

  it('slugifies names (accents, case, separators) with product fallback', () => {
    expect(slugifyProductName('ASUS TUF GeForce RTX-5090 32GB')).toBe(
      'asus-tuf-geforce-rtx-5090-32gb',
    );
    expect(slugifyProductName('Tarjeta Gráfica Ñandú Pro')).toBe('tarjeta-grafica-nandu-pro');
    expect(slugifyProductName('   ')).toBe('product');
  });

  it('generates unique-looking slug candidates within the 100-char limit', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const slug = generateSlugCandidate('Ultrabook Pro 14');
      expect(slug.startsWith('ultrabook-pro-14-')).toBe(true);
      expect(slug.length).toBeLessThanOrEqual(100);
      seen.add(slug);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
