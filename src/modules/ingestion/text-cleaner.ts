/**
 * Deterministic text cleaning for the ingestion pipeline (see ADR 0019).
 *
 * Markdown is already text, so no parsing library is used: a small ordered
 * set of transformations strips markup while preserving the two structures
 * the chunker depends on — `#` section headings and `| … |` table rows.
 * Cleaning is pure (no I/O) and idempotent (`clean(clean(x)) === clean(x)`).
 */

const FENCE_PATTERN = /^```.*$/gm;
const IMAGE_PATTERN = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
const HEADING_PATTERN = /^(#{1,6})\s+(.*?)\s*#*\s*$/gm;
const BOLD_PATTERN = /(\*\*|__)(.*?)\1/g;
const ITALIC_PATTERN = /(^|\W)\*([^*\n]+)\*(?=\W|$)/g;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const RULE_PATTERN = /^\s*(---|\*\*\*|___)\s*$/gm;
const QUOTE_PATTERN = /^\s*>\s?/gm;
const CONTROL_CHARS_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Detects a markdown table row (`| cell | cell |`, incl. `| --- |` rules). */
export function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 3;
}

/** Detects a markdown section heading (`# …` … `###### …`). */
export function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s+\S/.test(line.trim());
}

/**
 * Cleans markdown (or the markdown-ish text produced from HTML) into plain
 * text with `#` headings and `|` tables preserved for the chunker.
 */
export function cleanMarkdownText(raw: string): string {
  const withoutFences = raw.replace(FENCE_PATTERN, '');
  const withoutImages = withoutFences.replace(IMAGE_PATTERN, '$1');
  const withoutLinks = withoutImages.replace(LINK_PATTERN, '$1');
  const normalizedHeadings = withoutLinks.replace(HEADING_PATTERN, '$1 $2');
  const withoutBold = normalizedHeadings.replace(BOLD_PATTERN, '$2');
  const withoutItalic = withoutBold.replace(ITALIC_PATTERN, '$1$2');
  const withoutInlineCode = withoutItalic.replace(INLINE_CODE_PATTERN, '$1');
  const lines = withoutInlineCode
    .replace(RULE_PATTERN, '')
    .replace(QUOTE_PATTERN, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''));
  return normalizeWhitespace(lines.join('\n'));
}

/** Minimal cleaning for plain-text sources (whitespace only, no markup). */
export function cleanPlainText(raw: string): string {
  return normalizeWhitespace(raw);
}

/** Shared final pass: control chars out, blank runs collapsed, trimmed. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_PATTERN, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
