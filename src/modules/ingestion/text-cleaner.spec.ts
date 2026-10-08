import { describe, expect, it } from 'vitest';
import {
  cleanMarkdownText,
  cleanPlainText,
  isHeadingLine,
  isTableLine,
  normalizeWhitespace,
} from './text-cleaner.js';

/** Pure unit tests for the deterministic text cleaners (see ADR 0019). */
describe('text-cleaner', () => {
  it('strips markdown markup but keeps link text and headings', () => {
    const cleaned = cleanMarkdownText(
      '# Title\n\nSee [the manual](https://example.com/m) and **bold** `code`.\n\n![alt](img.png)',
    );
    expect(cleaned).toContain('# Title');
    expect(cleaned).toContain('See the manual and bold code.');
    expect(cleaned).toContain('alt');
    expect(cleaned).not.toContain('](https://');
    expect(cleaned).not.toContain('**');
  });

  it('removes fences, rules and quote markers, keeping the content', () => {
    const cleaned = cleanMarkdownText('```\nram_gb: 16\n```\n\n---\n\n> quoted line');
    expect(cleaned).toContain('ram_gb: 16');
    expect(cleaned).not.toContain('```');
    expect(cleaned).not.toContain('---');
    expect(cleaned).not.toContain('> quoted line');
    expect(cleaned).toContain('quoted line');
  });

  it('preserves markdown table rows verbatim', () => {
    const table = '| Spec | Value |\n| --- | --- |\n| ram_gb | 16 |';
    const cleaned = cleanMarkdownText(table);
    expect(cleaned).toContain('| Spec | Value |');
    expect(cleaned).toContain('| ram_gb | 16 |');
  });

  it('normalizes whitespace and drops control characters', () => {
    expect(normalizeWhitespace('a\r\n\r\n\r\nb')).toBe('a\n\nb');
    // Trailing spaces go; interior spacing and indentation stay untouched.
    expect(cleanPlainText('a  b   \n  c')).toBe('a  b\n  c');
    expect(cleanPlainText('a b')).toBe('a b');
  });

  it('is idempotent', () => {
    const raw = '# T\n\nText **bold** with [link](https://x.example/y).\n\n| a | b |\n| 1 | 2 |';
    const once = cleanMarkdownText(raw);
    expect(cleanMarkdownText(once)).toBe(once);
  });

  it('detects headings and table lines for the chunker', () => {
    expect(isHeadingLine('# Section')).toBe(true);
    expect(isHeadingLine('### Deep')).toBe(true);
    expect(isHeadingLine('#nospace')).toBe(false);
    expect(isHeadingLine('plain')).toBe(false);
    expect(isTableLine('| a | b |')).toBe(true);
    expect(isTableLine('| --- | --- |')).toBe(true);
    expect(isTableLine('a | b')).toBe(false);
  });
});
