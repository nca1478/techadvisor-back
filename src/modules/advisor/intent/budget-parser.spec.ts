import { describe, expect, it } from 'vitest';
import {
  parseBudgetHint,
  parseBudgetHints,
  parseMajorAmount,
  toMinorUnits,
} from './budget-parser.js';

describe('parseMajorAmount', () => {
  it('parses plain integers', () => {
    expect(parseMajorAmount('800')).toBe(800);
  });

  it('parses decimal dots and commas (es/en)', () => {
    expect(parseMajorAmount('1.5', 'k')).toBe(1500);
    expect(parseMajorAmount('1,5', 'k')).toBe(1500);
  });

  it('parses thousand separators without a multiplier', () => {
    expect(parseMajorAmount('1,200')).toBe(1200);
    expect(parseMajorAmount('1.200')).toBe(1200);
    expect(parseMajorAmount('1,200.50')).toBe(1200.5);
  });

  it('applies es/en multipliers (mil, millones, millions, k, m)', () => {
    expect(parseMajorAmount('4', 'millones')).toBe(4_000_000);
    expect(parseMajorAmount('1,5', 'millones')).toBe(1_500_000);
    expect(parseMajorAmount('2', 'million')).toBe(2_000_000);
    expect(parseMajorAmount('1.5', 'k')).toBe(1500);
    expect(parseMajorAmount('500', 'mil')).toBe(500_000);
  });
});

describe('toMinorUnits', () => {
  it('converts two-decimal currencies (USD/EUR) to cents', () => {
    expect(toMinorUnits(800, 'USD')).toBe(80000);
    expect(toMinorUnits(1.5, 'EUR')).toBe(150);
  });

  it('keeps zero-decimal currencies whole (JPY)', () => {
    expect(toMinorUnits(800, 'JPY')).toBe(800);
  });
});

describe('parseBudgetHints', () => {
  it('parses "máximo 800 dólares" as 80000 minor USD', () => {
    expect(parseBudgetHints('portátil para programar, máximo 800 dólares', 'USD')).toEqual({
      maxPrice: { amount: 80000, currency: 'USD' },
    });
  });

  it('parses "under $800" with the default currency', () => {
    expect(parseBudgetHints('laptop for programming, under $800', 'USD')).toEqual({
      maxPrice: { amount: 80000, currency: 'USD' },
    });
  });

  it('parses "$1.5k USD" as 150000 minor USD', () => {
    expect(parseBudgetHints('laptop $1.5k USD', 'USD')).toEqual({
      maxPrice: { amount: 150000, currency: 'USD' },
    });
  });

  it('parses "4 millones de pesos" with the session currency fallback', () => {
    expect(parseBudgetHints('4 millones de pesos', 'USD')).toEqual({
      maxPrice: { amount: 400_000_000, currency: 'USD' },
    });
  });

  it('parses euro amounts ("€500", "500 euros")', () => {
    expect(parseBudgetHints('portátil de hasta €500', 'USD')).toEqual({
      maxPrice: { amount: 50000, currency: 'EUR' },
    });
    expect(parseBudgetHints('laptop up to 500 euros', 'USD')).toEqual({
      maxPrice: { amount: 50000, currency: 'EUR' },
    });
  });

  it('detects a floor ("desde 300 dólares") as minPrice', () => {
    expect(parseBudgetHints('busco algo desde 300 dólares', 'USD')).toEqual({
      minPrice: { amount: 30000, currency: 'USD' },
    });
  });

  it('parses ranges ("entre 300 y 800 dólares") as min + max', () => {
    expect(parseBudgetHints('entre 300 y 800 dólares', 'USD')).toEqual({
      minPrice: { amount: 30000, currency: 'USD' },
      maxPrice: { amount: 80000, currency: 'USD' },
    });
  });

  it('ignores spec numbers without currency or budget context ("16GB RAM")', () => {
    expect(parseBudgetHints('laptop with 16GB RAM for Docker', 'USD')).toEqual({});
  });

  it('returns {} when no money is mentioned', () => {
    expect(parseBudgetHints('portátil para programar con Docker', 'USD')).toEqual({});
  });
});

describe('parseBudgetHint', () => {
  it('returns the max hint with its kind', () => {
    expect(parseBudgetHint('máximo 800 dólares', 'USD')).toEqual({
      amount: 80000,
      currency: 'USD',
      kind: 'max',
    });
  });

  it('returns null when nothing monetary is found', () => {
    expect(parseBudgetHint('hola, ¿qué tal?', 'USD')).toBeNull();
  });
});
