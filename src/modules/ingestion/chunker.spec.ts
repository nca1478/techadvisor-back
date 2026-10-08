import { describe, expect, it } from 'vitest';
import { chunkText } from './chunker.js';
import { CHUNK_MAX_CHARS, estimateTokens } from './ingestion.constants.js';

/**
 * Pure unit tests for the structure-aware chunker (see ADR 0019).
 * No database, no provider, no I/O — deterministic for a given input.
 */

function lorem(paragraphs: number, wordsPerParagraph = 60): string {
  const words = Array.from({ length: wordsPerParagraph }, (_, i) => `word${String(i)}`);
  return Array.from({ length: paragraphs }, () => words.join(' ')).join('\n\n');
}

function specTable(rows: number): string {
  const header = '| Spec | Value |\n| --- | --- |';
  const body = Array.from(
    { length: rows },
    (_, i) => `| spec_${String(i)} | value ${String(i)} with some descriptive text |`,
  );
  return [header, ...body].join('\n');
}

describe('chunkText', () => {
  it('returns no chunks for empty or blank input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('keeps a short text in a single section-0 chunk', () => {
    const chunks = chunkText('Short product note about RAM.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('Short product note about RAM.');
    expect(chunks[0]?.section).toBe(0);
  });

  it('limits chunks to ~300-500 tokens with ~50 overlap', () => {
    const chunks = chunkText(lorem(30));
    expect(chunks.length).toBeGreaterThan(2);
    // Hard cap respected everywhere (only whole tables may exceed it).
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
    // Full chunks (all but the tail) carry 300+ tokens.
    for (const chunk of chunks.slice(0, -1)) {
      const tokens = estimateTokens(chunk.content);
      expect(tokens).toBeGreaterThanOrEqual(300);
      expect(tokens).toBeLessThanOrEqual(550);
    }
  });

  it('overlaps consecutive chunks by ~50 tokens at a word boundary', () => {
    const chunks = chunkText(lorem(30));
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const prev = chunks[i]?.content ?? '';
      const next = chunks[i + 1]?.content ?? '';
      // The last ~15 words of the previous chunk (~100 chars, inside the
      // ~200-char overlap) reappear verbatim at the start of the next chunk.
      const probe = prev.split(/\s+/).slice(-15).join(' ');
      expect(probe.length).toBeGreaterThan(50);
      expect(next.slice(0, 400)).toContain(probe);
      // The next chunk opens with overlap, not fresh content: its first
      // words come from the previous chunk.
      const nextHead = next.split(/\s+/).slice(0, 5).join(' ');
      expect(prev).toContain(nextHead);
    }
  });

  it('starts a new section per heading and keeps the heading text', () => {
    const text = [
      '# Overview',
      '',
      lorem(4),
      '',
      '# Specifications',
      '',
      lorem(4),
      '',
      '# Warranty',
      '',
      lorem(2),
    ].join('\n');
    const chunks = chunkText(text);
    const sections = new Set(chunks.map((chunk) => chunk.section));
    expect(sections.size).toBeGreaterThanOrEqual(3);
    const specsChunk = chunks.find((chunk) => chunk.content.includes('# Specifications'));
    expect(specsChunk).toBeDefined();
    expect(specsChunk?.section).toBeGreaterThan(chunks[0]?.section ?? -1);
    // Content before the first heading stays in section 0 — verified with a
    // heading-free prefix below.
    const prefixed = chunkText(`${lorem(1)}\n\n# First\n\n${lorem(1)}`);
    expect(prefixed[0]?.section).toBe(0);
    expect(prefixed.some((chunk) => chunk.section === 1)).toBe(true);
  });

  it('never splits a spec table across chunks', () => {
    const text = [lorem(8), '', specTable(12), '', lorem(8)].join('\n');
    const chunks = chunkText(text);
    const firstRow = '| spec_0 | value 0 with some descriptive text |';
    const lastRow = '| spec_11 | value 11 with some descriptive text |';
    const holder = chunks.find((chunk) => chunk.content.includes(firstRow));
    expect(holder).toBeDefined();
    expect(holder?.content).toContain(lastRow);
  });

  it('keeps an oversize table whole instead of breaking rows', () => {
    const table = specTable(60);
    expect(table.length).toBeGreaterThan(CHUNK_MAX_CHARS);
    const chunks = chunkText(table);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('| spec_0 |');
    expect(chunks[0]?.content).toContain('| spec_59 |');
  });

  it('is deterministic for the same input', () => {
    const text = ['# Title', '', lorem(10), '', specTable(6), '', lorem(6)].join('\n');
    expect(chunkText(text)).toEqual(chunkText(text));
  });
});
