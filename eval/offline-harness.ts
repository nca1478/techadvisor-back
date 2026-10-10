import { performance } from 'node:perf_hooks';
import { FakeLlmAdapter } from '../src/modules/ai/adapters/fake-llm.adapter.js';
import type { EmbeddingProvider } from '../src/modules/ai/interfaces/embedding-provider.interface.js';
import type { LlmProvider } from '../src/modules/ai/interfaces/llm-provider.interface.js';
import { abstentionMessage } from '../src/modules/advisor/advisor.service.js';
import { buildCitations, extractCitationNumbers } from '../src/modules/advisor/citations.js';
import type { ProductQaCitationDto } from '../src/modules/advisor/dto/advisor.dto.js';
import { fuseRankings } from '../src/modules/retrieval/reciprocal-rank-fusion.js';
import type { RetrievalHit } from '../src/modules/retrieval/retrieval.service.js';
import type { EvalCase, EvalCorpusChunk } from './qa.schema.js';

/**
 * Offline-capable RAG evaluation harness (Fase 7, see ADR 0038).
 *
 * The harness pools every case's `corpus` chunks into one shared corpus
 * (unrelated cases act as realistic distractors) and runs a hybrid
 * retrieval over it: a vector branch (cosine over `EmbeddingProvider`
 * vectors — fake and deterministic offline, real online) plus a lexical
 * branch (content-token overlap, standing in for the `tsvector` branch
 * that needs PostgreSQL), fused with the production `fuseRankings` (RRF).
 *
 * Policy mirrors `AdvisorService`: abstention happens WITHOUT calling the
 * LLM when evidence is missing (no lexical grounding, or best fused score
 * below `ABSTAIN_MIN_SCORE`), citations resolve through the production
 * `buildCitations`, and deterministic rules (compatibility verdict, budget
 * filter) live in code — the LLM only drafts prose over delivered evidence.
 */

export const HARNESS_ABSTAIN_MIN_SCORE = 0.016;
export const HARNESS_GENERATION_TOP_N = 3;
export const HARNESS_VECTOR_MIN_SIM = 0.3;
export const HARNESS_LEXICAL_MIN_OVERLAP = 2;

const ES_STOPWORDS = new Set([
  'de',
  'la',
  'el',
  'en',
  'y',
  'a',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'con',
  'para',
  'por',
  'que',
  'qué',
  'se',
  'su',
  'sus',
  'al',
  'del',
  'es',
  'son',
  'como',
  'cómo',
  'más',
  'pero',
  'si',
  'no',
  'ni',
  'me',
  'te',
  'le',
  'les',
  'mi',
  'mis',
  'tu',
  'tus',
  'este',
  'esta',
  'estos',
  'estas',
  'ese',
  'esa',
  'hay',
  'cuál',
  'cuáles',
  'cuánto',
  'cuánta',
  'cuántos',
  'cuántas',
  'dónde',
  'donde',
  'cuándo',
  'cuando',
  'además',
  'ademas',
  'ser',
]);

const EN_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'in',
  'on',
  'for',
  'with',
  'to',
  'is',
  'are',
  'was',
  'were',
  'be',
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'do',
  'does',
  'did',
  'can',
  'could',
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'me',
  'him',
  'us',
  'them',
  'this',
  'that',
  'these',
  'those',
  'there',
  'here',
  'if',
  'then',
  'than',
  'so',
  'as',
  'at',
  'by',
  'from',
  'not',
  'have',
  'has',
  'had',
  'will',
  'would',
  'should',
  'may',
  'also',
  'without',
]);

/** Lowercase alphanumeric tokens (accents kept, hyphens split). */
export function tokenize(text: string, locale: string): string[] {
  const stopwords = locale.toLowerCase().startsWith('es') ? ES_STOPWORDS : EN_STOPWORDS;
  return text
    .toLowerCase()
    .split(/[^a-z0-9áéíóúüñ]+/gu)
    .filter((token) => token.length > 0 && !stopwords.has(token));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface HarnessOptions {
  llm: LlmProvider;
  embeddings: EmbeddingProvider;
  /** Retrieval depth for recall@k (default 5). */
  k: number;
  candidateK?: number;
}

export interface HarnessCaseOutcome {
  caseId: string;
  /** Full fused ranking (chunk ids, best first). */
  ranking: string[];
  delivered: RetrievalHit[];
  answer: string;
  citations: ProductQaCitationDto[];
  markers: number[];
  abstained: boolean;
  latencyMs: number;
  /** Recommendation cases: SQL-hydrated cards (never from the LLM). */
  products: { id: string; name: string }[];
}

interface ScoredChunk {
  chunk: EvalCorpusChunk;
  vector: number[];
}

/** `800 USD` / `150 EUR` / `hasta 500 €` → { amountMinor, currency }. */
export function parseBudget(question: string): { amountMinor: number; currency: string } | null {
  const match = question.match(/(\d[\d.,]*)\s*(usd|eur|€|\$)/i);
  if (!match) {
    return null;
  }
  const [, amountRaw = '', currencyRaw = ''] = match;
  const amount = Number.parseFloat(amountRaw.replace(/,/g, ''));
  if (!Number.isFinite(amount)) {
    return null;
  }
  const currency = currencyRaw.toUpperCase() === 'EUR' || currencyRaw === '€' ? 'EUR' : 'USD';
  return { amountMinor: Math.round(amount * 100), currency };
}

/** Deterministic budget + stock filter (mirrors SQL-side candidate query). */
export function eligibleProducts(c: EvalCase): { id: string; name: string }[] {
  const budget = parseBudget(c.question);
  return c.products
    .filter((p) => {
      if (!p.inStock) {
        return false;
      }
      if (budget && p.currency === budget.currency) {
        return p.priceAmount <= budget.amountMinor;
      }
      return true;
    })
    .map((p) => ({ id: p.id, name: p.name }));
}

function verdictLine(c: EvalCase): string {
  const verdict = c.expectedVerdict ?? 'compatible';
  return c.locale === 'es' ? `Veredicto: ${verdict}.` : `Verdict: ${verdict}.`;
}

/**
 * Offline answer script: composes the reply ONLY from delivered evidence
 * (plus deterministic rule outputs). The scripted text is enqueued into the
 * shared `FakeLlmAdapter` so the call path — prompt shape, `generate`,
 * citation building — is identical to the online path with a real provider.
 */
export function scriptOfflineAnswer(c: EvalCase, delivered: RetrievalHit[]): string {
  if (c.type === 'recommendation') {
    const names = eligibleProducts(c).map((p) => p.name);
    return c.locale === 'es'
      ? `Recomendación dentro de tu presupuesto: ${names.join(', ')}. Consulta la ficha de cada producto para más detalles.`
      : `Recommendation within your budget: ${names.join(', ')}. See each product page for details.`;
  }
  const prefix = c.type === 'compatibility' ? `${verdictLine(c)} ` : '';
  const evidence = delivered
    .slice(0, HARNESS_GENERATION_TOP_N)
    .map((hit, index) => `${hit.content} [${String(index + 1)}]`)
    .join(' ');
  return `${prefix}${evidence}`;
}

function buildPrompt(c: EvalCase, delivered: RetrievalHit[]): { system: string; question: string } {
  const localeName = c.locale === 'es' ? 'Spanish' : 'English';
  const system =
    `You are a shopping assistant. Answer in ${localeName} using ONLY the numbered evidence below. ` +
    `Cite sources as [n]. Never invent prices, stock levels, or product ids. ` +
    `If the evidence is insufficient, reply with exactly: ${abstentionMessage(c.locale)}`;
  const evidence = delivered
    .slice(0, HARNESS_GENERATION_TOP_N)
    .map((hit, index) => `[${String(index + 1)}] ${hit.content}`)
    .join('\n');
  let extra = '';
  if (c.type === 'compatibility') {
    extra =
      c.locale === 'es'
        ? `\nVeredicto determinado por reglas de ingeniería (debes indicarlo): ${c.expectedVerdict ?? 'compatible'}.`
        : `\nCompatibility verdict determined by engineering rules (you must state it): ${c.expectedVerdict ?? 'compatible'}.`;
  } else if (c.type === 'recommendation') {
    const eligible = eligibleProducts(c);
    extra =
      (c.locale === 'es'
        ? '\nProductos elegibles (base de datos, recomienda SOLO estos por nombre, sin precios ni ids): '
        : '\nEligible products (database, recommend ONLY these by name, no prices or ids): ') +
      JSON.stringify(eligible.map((p) => p.name));
  }
  return { system, question: `Question: ${c.question}\nEvidence:\n${evidence}${extra}` };
}

/** Runs every case through retrieval + generation. Sequential (deterministic). */
export async function runHarness(
  cases: EvalCase[],
  options: HarnessOptions,
): Promise<HarnessCaseOutcome[]> {
  const candidateK = options.candidateK ?? 20;
  const corpus: EvalCorpusChunk[] = cases.flatMap((c) => c.corpus);
  const chunkVectors = await options.embeddings.embed(corpus.map((c) => c.content));
  const scored: ScoredChunk[] = corpus.map((chunk, i) => ({
    chunk,
    vector: chunkVectors[i] ?? [],
  }));

  const outcomes: HarnessCaseOutcome[] = [];
  for (const c of cases) {
    const started = performance.now();
    const queryTokens = new Set(tokenize(c.question, c.locale));
    const queryVector =
      (await options.embeddings.embed([c.question], { kind: 'query' })).at(0) ?? [];

    const lexical = scored
      .map((s) => ({
        s,
        // Distinct shared content tokens (duplicates must not inflate the
        // score: "garantía" twice is still one evidence signal).
        overlap: new Set(
          tokenize(s.chunk.content, s.chunk.locale).filter((t) => queryTokens.has(t)),
        ).size,
        sim: cosineSimilarity(queryVector, s.vector),
      }))
      .filter((entry) => entry.overlap >= HARNESS_LEXICAL_MIN_OVERLAP)
      .sort(
        (a, b) => b.overlap - a.overlap || b.sim - a.sim || (a.s.chunk.id < b.s.chunk.id ? -1 : 1),
      )
      .slice(0, candidateK);

    const vector = scored
      .map((s) => ({ s, sim: cosineSimilarity(queryVector, s.vector) }))
      .filter((entry) => entry.sim >= HARNESS_VECTOR_MIN_SIM)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, candidateK);

    const fused = fuseRankings(
      [vector.map((e) => e.s.chunk.id), lexical.map((e) => e.s.chunk.id)],
      { k: 60 },
    );
    const byId = new Map(scored.map((s) => [s.chunk.id, s.chunk]));
    const ranking = fused.map((entry) => entry.id);
    const best = fused[0]?.score ?? 0;

    // Lexical grounding gate (mirrors AdvisorService abstention): no text
    // evidence, or nothing ranked first in either branch → abstain WITHOUT
    // calling the LLM.
    if (lexical.length === 0 || best < HARNESS_ABSTAIN_MIN_SCORE) {
      outcomes.push({
        caseId: c.id,
        ranking,
        delivered: [],
        answer: abstentionMessage(c.locale),
        citations: [],
        markers: [],
        abstained: true,
        latencyMs: performance.now() - started,
        products: [],
      });
      continue;
    }

    const delivered: RetrievalHit[] = fused.slice(0, HARNESS_GENERATION_TOP_N).map((entry) => {
      const chunk = byId.get(entry.id);
      if (!chunk) {
        throw new Error(`Harness corpus missing chunk ${entry.id}`);
      }
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        productId: null,
        content: chunk.content,
        locale: chunk.locale,
        score: entry.score,
        source: { title: chunk.title, docType: chunk.docType, sourceUrl: null },
      };
    });

    if (options.llm instanceof FakeLlmAdapter) {
      options.llm.enqueueTexts([scriptOfflineAnswer(c, delivered)]);
    }
    const prompt = buildPrompt(c, delivered);
    const generated = await options.llm.generate({
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.question }],
    });
    const markers = extractCitationNumbers(generated.text);
    const citations = buildCitations(generated.text, delivered);
    outcomes.push({
      caseId: c.id,
      ranking,
      delivered,
      answer: generated.text,
      citations,
      markers,
      abstained: false,
      latencyMs: performance.now() - started,
      products: c.type === 'recommendation' ? eligibleProducts(c) : [],
    });
  }
  return outcomes;
}
