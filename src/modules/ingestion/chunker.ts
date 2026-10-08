import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS } from './ingestion.constants.js';
import { isHeadingLine, isTableLine } from './text-cleaner.js';

/**
 * Structure-aware text chunker (see ADR 0019).
 *
 * Splits cleaned text into ~300–500 token chunks (`TARGET ≈ 1600` chars,
 * `MAX ≈ 2000` chars at ~4 chars/token) with ~50 token overlap
 * (`OVERLAP ≈ 200` chars, cut at a word boundary). Headings start a new
 * section (recorded per chunk for citations); consecutive `| … |` lines form
 * a table block that is never split — an oversize table becomes one oversize
 * chunk rather than a broken one.
 *
 * Pure function: no I/O, no logging, deterministic for a given input.
 */

export interface TextChunk {
  /** Plain chunk text, trimmed, with overlap prefix included. */
  content: string;
  /** Zero-based section index (incremented by each `#` heading). */
  section: number;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

interface Block {
  kind: 'heading' | 'table' | 'paragraph';
  text: string;
}

/** Splits cleaned text into overlapping, section-tagged chunks. */
export function chunkText(cleaned: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = options.maxChars ?? CHUNK_MAX_CHARS;
  const overlapChars = options.overlapChars ?? CHUNK_OVERLAP_CHARS;

  const blocks = splitOversizeParagraphs(splitBlocks(cleaned), maxChars);
  const chunks: TextChunk[] = [];
  let current = '';
  /** Leading length of `current` that is carried overlap, not fresh content. */
  let overlapLength = 0;
  let section = 0;
  let chunkSection = 0;

  const hasFreshContent = (): boolean => current.trim().length > overlapLength;

  const emit = (): void => {
    const content = current.trim();
    if (content.length > 0) {
      chunks.push({ content, section: chunkSection });
    }
    current = overlapPrefix(content, overlapChars);
    overlapLength = current.length;
  };

  const appendBlock = (text: string): void => {
    if (current.trim().length === 0) {
      current = text;
      chunkSection = section;
      return;
    }
    current = `${current.trimEnd()}\n\n${text}`;
  };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      // Drop pure-overlap residue: it belongs to the previous chunk and
      // must not become a tiny duplicate chunk of its own.
      if (hasFreshContent()) {
        emit();
      } else {
        current = '';
        overlapLength = 0;
      }
      section += 1;
      chunkSection = section;
      current = block.text;
      overlapLength = 0;
      continue;
    }
    // A table block is never split: flush fresh content first so the table
    // starts its own chunk (on top of the overlap prefix).
    if (block.kind === 'table' && hasFreshContent()) {
      emit();
    }
    const candidate =
      current.trim().length === 0 ? block.text : `${current.trimEnd()}\n\n${block.text}`;
    if (candidate.length > maxChars && hasFreshContent()) {
      emit();
      appendBlock(block.text);
      if (block.kind === 'table' && current.length > maxChars) {
        // Oversize table + overlap still past MAX: keep the table whole and
        // clean (documented exception, no overlap prefix).
        current = block.text;
        overlapLength = 0;
      }
    } else {
      appendBlock(block.text);
    }
  }
  const tail = current.trim();
  if (tail.length > 0) {
    chunks.push({ content: tail, section: chunkSection });
  }
  return chunks;
}

/**
 * Groups lines into blocks: headings stand alone, consecutive table lines
 * merge into one block, and consecutive prose lines merge into a paragraph.
 * Blank lines only separate blocks (they never appear in chunk text).
 */
function splitBlocks(cleaned: string): Block[] {
  const blocks: Block[] = [];
  const paragraph: string[] = [];
  const table: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph.length = 0;
    }
  };
  const flushTable = (): void => {
    if (table.length > 0) {
      blocks.push({ kind: 'table', text: table.join('\n') });
      table.length = 0;
    }
  };

  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushParagraph();
      flushTable();
      continue;
    }
    if (isHeadingLine(line)) {
      flushParagraph();
      flushTable();
      blocks.push({ kind: 'heading', text: line });
      continue;
    }
    if (isTableLine(line)) {
      flushParagraph();
      table.push(line);
      continue;
    }
    flushTable();
    paragraph.push(line);
  }
  flushParagraph();
  flushTable();
  return blocks;
}

/**
 * Hard-splits pathological single paragraphs past MAX at word boundaries so
 * the only chunks allowed past MAX are whole tables.
 */
function splitOversizeParagraphs(blocks: Block[], maxChars: number): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    if (block.kind !== 'paragraph' || block.text.length <= maxChars) {
      out.push(block);
      continue;
    }
    let rest = block.text;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut <= 0) {
        cut = maxChars;
      }
      out.push({ kind: 'paragraph', text: rest.slice(0, cut) });
      rest = rest.slice(cut).trimStart();
    }
    if (rest.length > 0) {
      out.push({ kind: 'paragraph', text: rest });
    }
  }
  return out;
}

/**
 * Trailing overlap of an emitted chunk, cut back to the next word boundary
 * so the following chunk never starts mid-word.
 */
function overlapPrefix(emitted: string, overlapChars: number): string {
  if (emitted.length <= overlapChars) {
    return emitted;
  }
  const tail = emitted.slice(-overlapChars);
  const boundary = tail.indexOf(' ');
  if (boundary === -1) {
    return tail;
  }
  return tail.slice(boundary + 1);
}
