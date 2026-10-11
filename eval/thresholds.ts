import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Versioned RAG quality thresholds (Fase 7).
 *
 * The gates live in `eval/thresholds.json` — never hardcoded in the runner —
 * so every change is a reviewable diff. Lowering any value to make a failing
 * change pass is forbidden without a justifying ADR
 * (see `docs/rag/evaluacion.md`).
 */
export const thresholdsSchema = z.object({
  version: z.literal(1),
  /** Retrieval depth the recall gate applies to (CI always runs `--k 5`). */
  retrievalK: z.number().int().min(1),
  minRecallAtK: z.number().min(0).max(1),
  minAbstentionAccuracy: z.number().min(0).max(1),
  minCitationValidityRate: z.number().min(0).max(1),
  maxHallucinationRate: z.number().min(0).max(1),
});

export type EvalThresholds = z.output<typeof thresholdsSchema>;

export interface EvalMetricsSummary {
  recallAtK: number;
  abstentionAccuracy: number;
  citationValidityRate: number;
  hallucinationRate: number;
}

export interface ThresholdCheck {
  passed: boolean;
  /** One human-readable line per violated gate (empty when passing). */
  failures: string[];
}

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'thresholds.json');

/** Loads and validates the thresholds file (defaults to `eval/thresholds.json`). */
export function loadThresholds(path: string = DEFAULT_PATH): EvalThresholds {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `eval thresholds: cannot read ${path} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = thresholdsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`eval thresholds: invalid ${path}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Pure gate check: a degrading change fails when ANY metric crosses its
 * threshold. Unit-tested in `thresholds.spec.ts` — this is what makes the
 * acceptance criterion ("below-threshold metrics break CI") verifiable
 * without running the full harness.
 */
export function checkThresholds(
  metrics: EvalMetricsSummary,
  thresholds: EvalThresholds,
): ThresholdCheck {
  const failures: string[] = [];
  if (metrics.recallAtK < thresholds.minRecallAtK) {
    failures.push(
      `recall@${String(thresholds.retrievalK)} ${metrics.recallAtK.toFixed(3)} < ${thresholds.minRecallAtK.toFixed(3)}`,
    );
  }
  if (metrics.abstentionAccuracy < thresholds.minAbstentionAccuracy) {
    failures.push(
      `abstention accuracy ${metrics.abstentionAccuracy.toFixed(3)} < ${thresholds.minAbstentionAccuracy.toFixed(3)}`,
    );
  }
  if (metrics.citationValidityRate < thresholds.minCitationValidityRate) {
    failures.push(
      `citation validity ${metrics.citationValidityRate.toFixed(3)} < ${thresholds.minCitationValidityRate.toFixed(3)}`,
    );
  }
  if (metrics.hallucinationRate > thresholds.maxHallucinationRate) {
    failures.push(
      `hallucination rate ${metrics.hallucinationRate.toFixed(3)} > ${thresholds.maxHallucinationRate.toFixed(3)}`,
    );
  }
  return { passed: failures.length === 0, failures };
}
