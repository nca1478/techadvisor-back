import { describe, expect, it } from 'vitest';
import {
  checkThresholds,
  loadThresholds,
  thresholdsSchema,
  type EvalThresholds,
} from './thresholds.js';

const BASE_THRESHOLDS: EvalThresholds = {
  version: 1,
  retrievalK: 5,
  minRecallAtK: 0.9,
  minAbstentionAccuracy: 0.8,
  minCitationValidityRate: 0.8,
  maxHallucinationRate: 0,
};

const PASSING_METRICS = {
  recallAtK: 1,
  abstentionAccuracy: 1,
  citationValidityRate: 1,
  hallucinationRate: 0,
};

describe('eval thresholds', () => {
  it('loads the versioned thresholds file with the documented gates', () => {
    const thresholds = loadThresholds();
    expect(thresholds).toEqual(BASE_THRESHOLDS);
  });

  it('rejects out-of-range gates', () => {
    expect(thresholdsSchema.safeParse({ ...BASE_THRESHOLDS, minRecallAtK: 1.5 }).success).toBe(
      false,
    );
    expect(
      thresholdsSchema.safeParse({ ...BASE_THRESHOLDS, maxHallucinationRate: -0.1 }).success,
    ).toBe(false);
    expect(thresholdsSchema.safeParse({ ...BASE_THRESHOLDS, version: 2 }).success).toBe(false);
  });

  it('fails the loader on a missing file instead of silently passing', () => {
    expect(() => loadThresholds('/nonexistent/eval-thresholds.json')).toThrow(/cannot read/);
  });

  it('passes when every metric meets its gate', () => {
    expect(checkThresholds(PASSING_METRICS, BASE_THRESHOLDS)).toEqual({
      passed: true,
      failures: [],
    });
  });

  it('fails when recall@k drops below the minimum (regression gate)', () => {
    const check = checkThresholds({ ...PASSING_METRICS, recallAtK: 0.5 }, BASE_THRESHOLDS);
    expect(check.passed).toBe(false);
    expect(check.failures.join(' ')).toContain('recall@5');
  });

  it('fails when abstention accuracy or citation validity degrade', () => {
    expect(
      checkThresholds({ ...PASSING_METRICS, abstentionAccuracy: 0.5 }, BASE_THRESHOLDS).passed,
    ).toBe(false);
    expect(
      checkThresholds({ ...PASSING_METRICS, citationValidityRate: 0.5 }, BASE_THRESHOLDS).passed,
    ).toBe(false);
  });

  it('fails on any hallucination (budget is zero)', () => {
    const check = checkThresholds({ ...PASSING_METRICS, hallucinationRate: 0.02 }, BASE_THRESHOLDS);
    expect(check.passed).toBe(false);
    expect(check.failures.join(' ')).toContain('hallucination');
  });
});
