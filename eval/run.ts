#!/usr/bin/env tsx
/**
 * RAG evaluation runner (Fase 7): `npm run eval -- [--offline] [flags]`.
 *
 * Loads `eval/qa.jsonl`, runs every case through the harness (retrieval +
 * generation without HTTP), scores recall@k / MRR / abstention / citations /
 * hallucinations / latency, and writes `eval/results/<fecha>-<modelo>.json`
 * plus a Markdown summary.
 *
 * Model switching is config-only: `--llm-provider`, `--llm-model`,
 * `--embedding-provider`, `--embedding-model` (or the equivalent env vars).
 * `--offline` forces the fake adapters so CI never touches a real provider.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { parseEnv } from '../src/config/env.schema.js';
import {
  createEmbeddingProvider,
  createLlmProvider,
} from '../src/modules/ai/ai-provider.factory.js';
import { FakeEmbeddingAdapter } from '../src/modules/ai/adapters/fake-embedding.adapter.js';
import { FakeLlmAdapter } from '../src/modules/ai/adapters/fake-llm.adapter.js';
import { runHarness } from './offline-harness.js';
import {
  checkCitationsValid,
  checkHallucination,
  containsFact,
  mean,
  percentile,
  reciprocalRank,
  recallAtK,
} from './metrics.js';
import { parseEvalCaseLine, type EvalCase, type EvalReport } from './qa.schema.js';

const EVAL_VERSION = 1;
/** Hallucination budget: invented prices/ids must never happen. */
const MAX_HALLUCINATION_RATE = 0;
/** Minimum abstention accuracy and citation validity to pass CI (`--strict`). */
const MIN_ABSTENTION_ACCURACY = 0.8;
const MIN_CITATION_VALIDITY_RATE = 0.8;

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  offline: boolean;
  k: number;
  candidateK: number;
  limit: number;
  typeFilter: string | null;
  dataset: string;
  resultsDir: string;
  strict: boolean;
  llmProvider?: string;
  llmModel?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    offline: false,
    k: 5,
    candidateK: 20,
    limit: 0,
    typeFilter: null,
    dataset: join(EVAL_DIR, 'qa.jsonl'),
    resultsDir: join(EVAL_DIR, 'results'),
    strict: false,
  };
  const takeValue = (key: string, value: string | undefined, i: number): [string, number] => {
    if (value !== undefined && value !== '') {
      return [value, i];
    }
    const next = argv.at(i + 1);
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Flag ${key} requires a value`);
    }
    return [next, i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? '';
    const [key, inline] = raw.includes('=')
      ? (raw.split('=', 2) as [string, string | undefined])
      : [raw, undefined];
    switch (key) {
      case '--offline':
        opts.offline = true;
        break;
      case '--strict':
        opts.strict = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      case '--k': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.k = Number.parseInt(v, 10);
        break;
      }
      case '--candidate-k': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.candidateK = Number.parseInt(v, 10);
        break;
      }
      case '--limit': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.limit = Number.parseInt(v, 10);
        break;
      }
      case '--type': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.typeFilter = v;
        break;
      }
      case '--dataset': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.dataset = resolve(v);
        break;
      }
      case '--results-dir': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.resultsDir = resolve(v);
        break;
      }
      case '--llm-provider': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.llmProvider = v;
        break;
      }
      case '--llm-model': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.llmModel = v;
        break;
      }
      case '--embedding-provider': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.embeddingProvider = v;
        break;
      }
      case '--embedding-model': {
        const [v, j] = takeValue(key, inline, i);
        i = j;
        opts.embeddingModel = v;
        break;
      }
      default:
        throw new Error(`Unknown flag ${key} (see --help)`);
    }
  }
  if (!Number.isInteger(opts.k) || opts.k < 1) {
    throw new Error('--k must be a positive integer');
  }
  return opts;
}

function printHelp(): void {
  console.log(`TechAdvisor RAG eval
Usage: npm run eval -- [flags]

  --offline               Force fake adapters (no network; for CI).
  --llm-provider NAME     Override LLM_PROVIDER (fake|openai-compatible|openai-responses|anthropic).
  --llm-model MODEL       Override LLM_MODEL.
  --embedding-provider N  Override EMBEDDING_PROVIDER (fake|openai-compatible|nvidia).
  --embedding-model MODEL Override EMBEDDING_MODEL.
  --k N                   Retrieval depth for recall@k (default 5).
  --candidate-k N         Candidates per branch (default 20).
  --limit N               Run only the first N cases (debug).
  --type TYPE             Run only one case type.
  --dataset PATH          Dataset path (default eval/qa.jsonl).
  --results-dir PATH      Report output dir (default eval/results).
  --strict                Exit 1 when quality thresholds fail.
  --help                  Show this help.`);
}

function loadDataset(path: string): EvalCase[] {
  const raw = readFileSync(path, 'utf8');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const cases = lines.map((line, i) => parseEvalCaseLine(line, i + 1));
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) {
      throw new Error(`eval dataset: duplicated case id ${c.id}`);
    }
    ids.add(c.id);
  }
  const chunkIds = new Set(cases.flatMap((c) => c.corpus.map((chunk) => chunk.id)));
  for (const c of cases) {
    for (const expected of c.expectedChunkIds) {
      if (!chunkIds.has(expected)) {
        throw new Error(`eval dataset: case ${c.id} expects unknown chunk ${expected}`);
      }
    }
  }
  return cases;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model'
  );
}

function stampDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(date.getUTCFullYear())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // Plain tsx does not load `.env` (Nest does that at boot), so load it here.
  // Flags still win: they overwrite the merged environment below.
  loadDotenv();
  const allCases = loadDataset(opts.dataset);
  const cases =
    opts.typeFilter !== null ? allCases.filter((c) => c.type === opts.typeFilter) : allCases;
  if (opts.typeFilter !== null && cases.length === 0) {
    throw new Error(`--type ${opts.typeFilter} matched no cases`);
  }
  const selected = opts.limit > 0 ? cases.slice(0, opts.limit) : cases;

  // Provider resolution is config-only: flags override env, then the real
  // factories build the adapters. Dummy infra vars keep `parseEnv` happy —
  // the eval never touches Postgres/Redis/JWT.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.llmProvider !== undefined) {
    env.LLM_PROVIDER = opts.llmProvider;
  }
  if (opts.llmModel !== undefined) {
    env.LLM_MODEL = opts.llmModel;
  }
  if (opts.embeddingProvider !== undefined) {
    env.EMBEDDING_PROVIDER = opts.embeddingProvider;
  }
  if (opts.embeddingModel !== undefined) {
    env.EMBEDDING_MODEL = opts.embeddingModel;
  }
  env.DATABASE_URL ??=
    'postgresql://techadvisor:techadvisor@localhost:5432/techadvisor?schema=public';
  env.REDIS_URL ??= 'redis://localhost:6379';
  env.JWT_SECRET ??= 'eval-only-dummy-secret-please-change';
  const config = parseEnv(env);

  // Offline forces fake adapters AND fake model names (unless a flag says
  // otherwise), so CI reports are always comparable and never leak real
  // provider names into filenames. Online records the resolved real config.
  const llmProviderName = opts.offline ? 'fake' : config.LLM_PROVIDER;
  const llmModel = opts.offline
    ? (opts.llmModel ?? 'fake-llm-v1')
    : (config.LLM_MODEL ?? 'fake-llm-v1');
  const embeddingProviderName = opts.offline ? 'fake' : config.EMBEDDING_PROVIDER;
  const embeddingModel = opts.offline
    ? (opts.embeddingModel ?? 'fake-hash-v1')
    : (config.EMBEDDING_MODEL ?? `embed-dim-${String(config.EMBEDDING_DIM)}`);

  const llm = opts.offline ? new FakeLlmAdapter({ model: llmModel }) : createLlmProvider(config);
  const embeddings = opts.offline
    ? new FakeEmbeddingAdapter({ model: embeddingModel, dimensions: 64 })
    : createEmbeddingProvider(config);

  const outcomes = await runHarness(selected, {
    llm,
    embeddings,
    k: opts.k,
    candidateK: opts.candidateK,
  });
  const byId = new Map(selected.map((c) => [c.id, c]));

  const caseResults = outcomes.map((outcome) => {
    const c = byId.get(outcome.caseId);
    if (!c) {
      throw new Error(`Harness returned unknown case ${outcome.caseId}`);
    }
    const recalled = recallAtK(c.expectedChunkIds, outcome.ranking.slice(0, opts.k));
    const rr = reciprocalRank(c.expectedChunkIds, outcome.ranking);
    const abstentionCorrect = outcome.abstained === c.expectAbstention;
    const factsTotal = outcome.abstained ? 0 : c.mustContain.length;
    const factsFound = outcome.abstained
      ? 0
      : c.mustContain.filter((fact) => containsFact(outcome.answer, fact)).length;
    const forbiddenHit = c.mustNotContain.filter((fact) => containsFact(outcome.answer, fact));
    const hallucination = checkHallucination(outcome.answer, c.question, c.allowedProductIds);
    const hallucinated = hallucination.hallucinated || forbiddenHit.length > 0;
    const hallucinationDetail = [
      hallucination.detail,
      forbiddenHit.length > 0 ? `forbidden terms: ${forbiddenHit.join(', ')}` : null,
    ]
      .filter((part) => part !== null)
      .join('; ');
    return {
      id: c.id,
      type: c.type,
      locale: c.locale,
      recalledAtK: recalled,
      reciprocalRank: rr,
      retrievedChunkIds: outcome.ranking.slice(0, opts.k),
      abstained: outcome.abstained,
      abstentionCorrect,
      factsFound,
      factsTotal,
      citationsValid: checkCitationsValid(
        outcome.markers,
        outcome.delivered.length,
        c.citationRequired,
      ),
      citationsCount: outcome.citations.length,
      hallucinated,
      hallucinationDetail: hallucinated ? hallucinationDetail : null,
      latencyMs: Math.round(outcome.latencyMs * 100) / 100,
    };
  });

  const withRecall = caseResults.filter((r) => r.recalledAtK !== null);
  const withRank = caseResults.filter((r) => r.reciprocalRank !== null);
  const metrics = {
    recallAtK: mean(withRecall.map((r) => r.recalledAtK ?? 0)),
    mrr: mean(withRank.map((r) => r.reciprocalRank ?? 0)),
    abstentionAccuracy: mean(caseResults.map((r) => (r.abstentionCorrect ? 1 : 0))),
    citationValidityRate: mean(caseResults.map((r) => (r.citationsValid ? 1 : 0))),
    hallucinationRate: mean(caseResults.map((r) => (r.hallucinated ? 1 : 0))),
    factCoverage:
      caseResults.reduce((sum, r) => sum + r.factsFound, 0) /
      Math.max(
        1,
        caseResults.reduce((sum, r) => sum + r.factsTotal, 0),
      ),
    latencyP50Ms: percentile(
      caseResults.map((r) => r.latencyMs),
      50,
    ),
    latencyP95Ms: percentile(
      caseResults.map((r) => r.latencyMs),
      95,
    ),
  };
  const thresholdsPassed =
    metrics.hallucinationRate <= MAX_HALLUCINATION_RATE &&
    metrics.abstentionAccuracy >= MIN_ABSTENTION_ACCURACY &&
    metrics.citationValidityRate >= MIN_CITATION_VALIDITY_RATE;

  const countBy = (key: (c: EvalCase) => string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const c of selected) {
      const k = key(c);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  };
  const report: EvalReport = {
    version: EVAL_VERSION,
    createdAt: new Date().toISOString(),
    dataset: {
      path: opts.dataset,
      cases: selected.length,
      byType: countBy((c) => c.type),
      byLocale: countBy((c) => c.locale),
    },
    providers: {
      llmProvider: llmProviderName,
      llmModel,
      embeddingProvider: embeddingProviderName,
      embeddingModel,
      offline: opts.offline,
    },
    retrievalK: opts.k,
    metrics,
    thresholds: {
      maxHallucinationRate: MAX_HALLUCINATION_RATE,
      minAbstentionAccuracy: MIN_ABSTENTION_ACCURACY,
      minCitationValidityRate: MIN_CITATION_VALIDITY_RATE,
    },
    thresholdsPassed,
    cases: caseResults,
  };

  mkdirSync(opts.resultsDir, { recursive: true });
  const base = `${stampDate(new Date())}-${slug(llmModel)}__${slug(embeddingModel)}`;
  const jsonPath = join(opts.resultsDir, `${base}.json`);
  const mdPath = join(opts.resultsDir, `${base}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(report));

  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  console.log(
    [
      `eval: ${String(selected.length)} cases (k=${String(opts.k)}, offline=${String(opts.offline)})`,
      `  recall@${String(opts.k)}      ${pct(metrics.recallAtK)}`,
      `  mrr                 ${metrics.mrr.toFixed(3)}`,
      `  abstention accuracy ${pct(metrics.abstentionAccuracy)}`,
      `  citation validity   ${pct(metrics.citationValidityRate)}`,
      `  hallucination rate  ${pct(metrics.hallucinationRate)} (budget ${pct(MAX_HALLUCINATION_RATE)})`,
      `  fact coverage       ${pct(metrics.factCoverage)}`,
      `  latency p50/p95     ${metrics.latencyP50Ms.toFixed(1)}ms / ${metrics.latencyP95Ms.toFixed(1)}ms`,
      `  thresholds: ${thresholdsPassed ? 'PASS' : 'FAIL'}`,
      `  report: ${jsonPath}`,
      `  summary: ${mdPath}`,
    ].join('\n'),
  );
  if (opts.strict && !thresholdsPassed) {
    process.exitCode = 1;
  }
}

function renderMarkdown(report: EvalReport): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const rows = report.cases
    .map(
      (c) =>
        `| ${c.id} | ${c.type} | ${c.locale} | ${c.recalledAtK === null ? 'n/a' : c.recalledAtK.toFixed(2)} | ` +
        `${c.reciprocalRank === null ? 'n/a' : c.reciprocalRank.toFixed(2)} | ${c.abstained ? 'yes' : 'no'}${c.abstentionCorrect ? '' : ' ✗'} | ` +
        `${String(c.factsFound)}/${String(c.factsTotal)} | ${c.citationsValid ? 'ok' : 'FAIL'} | ` +
        `${c.hallucinated ? `HALLUCINATED (${c.hallucinationDetail ?? ''})` : 'no'} | ${c.latencyMs.toFixed(1)} |`,
    )
    .join('\n');
  return (
    `# RAG evaluation — ${report.createdAt}

Providers: LLM \`${report.providers.llmProvider}/${report.providers.llmModel}\`, embeddings ` +
    `\`${report.providers.embeddingProvider}/${report.providers.embeddingModel}\` (offline: ${String(report.providers.offline)}).
Dataset: \`${report.dataset.path}\` — ${String(report.dataset.cases)} cases, k=${String(report.retrievalK)}.

## Metrics

| metric | value | threshold |
|---|---|---|
| recall@${String(report.retrievalK)} | ${pct(report.metrics.recallAtK)} | — |
| MRR | ${report.metrics.mrr.toFixed(3)} | — |
| abstention accuracy | ${pct(report.metrics.abstentionAccuracy)} | ≥ ${pct(report.thresholds.minAbstentionAccuracy)} |
| citation validity | ${pct(report.metrics.citationValidityRate)} | ≥ ${pct(report.thresholds.minCitationValidityRate)} |
| hallucination rate | ${pct(report.metrics.hallucinationRate)} | ≤ ${pct(report.thresholds.maxHallucinationRate)} |
| fact coverage | ${pct(report.metrics.factCoverage)} | — |
| latency p50 / p95 | ${report.metrics.latencyP50Ms.toFixed(1)}ms / ${report.metrics.latencyP95Ms.toFixed(1)}ms | — |

Thresholds: **${report.thresholdsPassed ? 'PASS' : 'FAIL'}**

## Cases

| id | type | locale | recall | RR | abstained | facts | citations | hallucination | ms |
|---|---|---|---|---|---|---|---|---|---|
${rows}

*Compare models by running the same dataset with different flags and diffing these files.*
`
  );
}

main().catch((error: unknown) => {
  console.error(`eval failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
