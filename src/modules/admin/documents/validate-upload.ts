/**
 * Strict upload validation for admin RAG documents (see ADR 0020).
 *
 * Framework-free on purpose: pure functions over bytes, unit-testable
 * without Nest. The declared MIME type is only a hint — the real type is
 * sniffed from magic bytes/content and must resolve to one of the four
 * formats the P2.4 extractor supports (PDF, HTML, Markdown, plain text).
 * Anything else (executables, archives, images, …) is rejected even when
 * mislabeled, and file bytes are never executed or interpreted here.
 */

export type UploadFormat = 'pdf' | 'html' | 'markdown' | 'text';

/** Declared MIME types accepted at the edge (the real type still wins). */
export const ALLOWED_DECLARED_MIME = [
  'application/pdf',
  'text/html',
  'text/markdown',
  'text/plain',
] as const;

/** Normalized MIME persisted on the document row per sniffed format. */
const FORMAT_MIME: Record<UploadFormat, string> = {
  pdf: 'application/pdf',
  html: 'text/html',
  markdown: 'text/markdown',
  text: 'text/plain',
};

const PDF_MAGIC = Buffer.from('%PDF-');

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

export interface ValidatedUpload {
  /** Sniffed format driving extraction (never the declared type alone). */
  format: UploadFormat;
  /** Normalized MIME persisted as `documents.mime_type`. */
  mimeType: string;
  sizeBytes: number;
}

function normalizeDeclared(contentType: string | undefined): string {
  return contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Sniffs the real source format from magic bytes, then the declared MIME.
 * Mirrors `DocumentExtractorService.detectFormat` so validation and
 * extraction can never disagree about what a file is.
 */
export function sniffFormat(raw: Buffer, declaredMime: string): UploadFormat {
  if (raw.length >= PDF_MAGIC.length && raw.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return 'pdf';
  }
  const mime = declaredMime;
  if (mime.includes('pdf')) {
    return 'pdf';
  }
  if (mime.includes('html')) {
    return 'html';
  }
  if (mime.includes('markdown')) {
    return 'markdown';
  }
  if (mime === '' || mime.startsWith('text/')) {
    return raw.toString('utf8', 0, Math.min(raw.length, 512)).trimStart().startsWith('<')
      ? 'html'
      : 'text';
  }
  throw new UploadValidationError(
    `Unsupported file type "${mime || 'unknown'}". Allowed types: PDF, HTML, Markdown or plain text.`,
  );
}

/**
 * Validates upload bytes: non-empty, within `maxBytes`, declared MIME in
 * the allowlist (when present), and a sniffed real type the extractor
 * supports. Returns the normalized metadata to persist.
 */
export function validateUpload(
  raw: Buffer,
  contentType: string | undefined,
  maxBytes: number,
): ValidatedUpload {
  if (raw.length === 0) {
    throw new UploadValidationError('The file is empty.');
  }
  if (raw.length > maxBytes) {
    throw new UploadValidationError(
      `The file is too large (${String(raw.length)} bytes, max ${String(maxBytes)} bytes).`,
    );
  }
  const declared = normalizeDeclared(contentType);
  if (declared !== '' && !(ALLOWED_DECLARED_MIME as readonly string[]).includes(declared)) {
    throw new UploadValidationError(
      `Unsupported file type "${declared}". Allowed types: PDF, HTML, Markdown or plain text.`,
    );
  }
  const format = sniffFormat(raw, declared);
  return { format, mimeType: FORMAT_MIME[format], sizeBytes: raw.length };
}
