import { describe, expect, it } from 'vitest';
import { extractSkuTokens, hasSkuPattern, isSkuLikeToken } from './sku-pattern.js';

describe('SKU/model heuristic (sku-pattern)', () => {
  it.each(['AURORA-X9000', 'RTX4070', 'XPS-13-9310', 'ING-ABC123', 'TL_8400X'])(
    'treats %s as SKU-like',
    (token) => {
      expect(isSkuLikeToken(token)).toBe(true);
      expect(isSkuLikeToken(token.toLowerCase())).toBe(true);
    },
  );

  it.each(['laptop', 'gaming', 'portátil', 'AM5', '4K', '16GB', 'XPS', '!!!', ''])(
    'does not treat %s as SKU-like',
    (token) => {
      expect(isSkuLikeToken(token)).toBe(false);
    },
  );

  it('extracts distinct SKU tokens from a natural-language query', () => {
    expect(extractSkuTokens('Does the AURORA-X9000 support aurora-x9000 RAM?')).toEqual([
      'AURORA-X9000',
    ]);
    expect(extractSkuTokens('Compare RTX4070 vs RTX4060 for gaming')).toEqual([
      'RTX4070',
      'RTX4060',
    ]);
  });

  it('detects the SKU pattern for full-text boosting', () => {
    expect(hasSkuPattern('Tell me about the AURORA-X9000 warranty')).toBe(true);
    expect(hasSkuPattern('Best laptop for engineering students')).toBe(false);
    expect(hasSkuPattern('')).toBe(false);
  });
});
