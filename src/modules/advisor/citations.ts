import type { RetrievalHit } from '../retrieval/retrieval.service.js';
import type { ProductQaCitationDto } from './dto/advisor.dto.js';

/** Evidence fragment length: enough context for a citation, bounded for the payload. */
export const CITATION_SNIPPET_MAX_LENGTH = 280;

/**
 * Extracts unique `[n]` citation markers from the assistant text, in order of
 * first appearance. Non-positive integers never match (`\d+` with a `[n]`
 * shape); out-of-range numbers are returned here and filtered by
 * `buildCitations`, so callers can distinguish "cited nothing" from "cited
 * something invalid" in tests.
 */
export function extractCitationNumbers(text: string): number[] {
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number.parseInt(match.at(1) ?? '', 10);
    if (!Number.isSafeInteger(n) || n < 1 || seen.has(n)) {
      continue;
    }
    seen.add(n);
    numbers.push(n);
  }
  return numbers;
}

/**
 * Resolves the assistant's `[n]` markers against the delivered evidence.
 * Markers outside `1..hits.length` are DISCARDED — an invented citation never
 * becomes a citation object (guardrail, see ADR 0025). Chunks are numbered in
 * delivery order, so `[1]` is `hits[0]`.
 */
export function buildCitations(text: string, hits: RetrievalHit[]): ProductQaCitationDto[] {
  const citations: ProductQaCitationDto[] = [];
  for (const n of extractCitationNumbers(text)) {
    const hit = hits.at(n - 1);
    if (hit === undefined) {
      continue;
    }
    citations.push({
      n,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      title: hit.source.title,
      snippet: toCitationSnippet(hit.content),
    });
  }
  return citations;
}

/** Collapses whitespace and truncates the evidence fragment to a fixed length. */
export function toCitationSnippet(
  content: string,
  maxLength: number = CITATION_SNIPPET_MAX_LENGTH,
): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength).trimEnd()}…`;
}
