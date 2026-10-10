import { describe, expect, it } from 'vitest';
import {
  checkCitationsValid,
  checkHallucination,
  containsFact,
  findHallucinatedPrices,
  findHallucinatedProductIds,
  mean,
  percentile,
  reciprocalRank,
  recallAtK,
} from './metrics.js';

describe('eval metrics', () => {
  it('recallAtK measures the fraction of expected ids in the top-k', () => {
    expect(recallAtK(['a', 'b'], ['a', 'x', 'b'])).toBeCloseTo(1);
    expect(recallAtK(['a', 'b'], ['a', 'x'])).toBeCloseTo(0.5);
    expect(recallAtK(['a'], ['x'])).toBe(0);
  });

  it('recallAtK returns null when the case expects no chunks', () => {
    expect(recallAtK([], ['a'])).toBeNull();
  });

  it('reciprocalRank uses the first expected hit', () => {
    expect(reciprocalRank(['b'], ['x', 'b', 'a'])).toBeCloseTo(0.5);
    expect(reciprocalRank(['a', 'b'], ['b'])).toBe(1);
    expect(reciprocalRank(['z'], ['a', 'b'])).toBe(0);
    expect(reciprocalRank([], ['a'])).toBeNull();
  });

  it('percentile uses the nearest-rank method', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([], 50)).toBe(0);
    expect(mean([])).toBe(0);
  });

  it('containsFact matches case-insensitively', () => {
    expect(containsFact('La BATERÍA dura 30 horas [1].', 'batería')).toBe(true);
    expect(containsFact('Sin datos.', 'batería')).toBe(false);
  });

  it('findHallucinatedPrices ignores amounts already in the question', () => {
    expect(
      findHallucinatedPrices('Dentro de tu presupuesto (800 USD): X.', 'máximo 800 USD'),
    ).toEqual([]);
    expect(findHallucinatedPrices('Cuesta 129 EUR.', '¿cuánto cuesta?')).toEqual(['129 EUR']);
  });

  it('findHallucinatedProductIds allows only allowlisted ids', () => {
    const answer =
      'Ver a1111111-1111-4111-8111-111111111111 y b2222222-2222-4222-8222-222222222222.';
    expect(findHallucinatedProductIds(answer, ['a1111111-1111-4111-8111-111111111111'])).toEqual([
      'b2222222-2222-4222-8222-222222222222',
    ]);
  });

  it('checkHallucination combines price and id signals', () => {
    expect(checkHallucination('Dura 30 horas [1].', '¿batería?', []).hallucinated).toBe(false);
    const bad = checkHallucination('Cuesta 99 USD.', '¿cuánto dura?', []);
    expect(bad.hallucinated).toBe(true);
    expect(bad.detail).toContain('99 USD');
  });

  it('checkCitationsValid enforces resolvable markers', () => {
    expect(checkCitationsValid([1, 2], 2, true)).toBe(true);
    expect(checkCitationsValid([3], 2, true)).toBe(false);
    expect(checkCitationsValid([], 2, true)).toBe(false);
    expect(checkCitationsValid([], 0, false)).toBe(true);
  });
});
