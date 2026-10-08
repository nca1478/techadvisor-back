import { describe, expect, it } from 'vitest';
import { UploadValidationError, sniffFormat, validateUpload } from './validate-upload.js';

const MAX = 1024;

describe('validateUpload', () => {
  it('accepts a PDF by magic bytes even when mislabeled as text/plain', () => {
    const raw = Buffer.from('%PDF-1.7 fake body with enough text to be readable', 'utf8');
    expect(validateUpload(raw, 'text/plain', MAX)).toMatchObject({
      format: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: raw.length,
    });
  });

  it('accepts markdown and plain text', () => {
    const md = Buffer.from('# Title\n\nSome readable content here.', 'utf8');
    expect(validateUpload(md, 'text/markdown', MAX).format).toBe('markdown');
    const txt = Buffer.from('Just some plain notes about the product.', 'utf8');
    expect(validateUpload(txt, 'text/plain', MAX).format).toBe('text');
  });

  it('rejects an empty file', () => {
    expect(() => validateUpload(Buffer.alloc(0), 'application/pdf', MAX)).toThrow(
      UploadValidationError,
    );
  });

  it('rejects an oversized file', () => {
    expect(() =>
      validateUpload(Buffer.from('x'.repeat(MAX + 1), 'utf8'), 'text/plain', MAX),
    ).toThrow(/too large/);
  });

  it('rejects a disallowed declared type with a clear error', () => {
    const exe = Buffer.from('MZ fake executable body', 'utf8');
    expect(() => validateUpload(exe, 'application/x-msdownload', MAX)).toThrow(
      /Allowed types: PDF, HTML, Markdown or plain text/,
    );
  });

  it('rejects bytes whose sniffed type is unsupported', () => {
    // Declared as octet-stream with no text/html/pdf markers and a MIME
    // outside text/*: sniffing must fail instead of guessing.
    const raw = Buffer.from('MZ fake executable body', 'utf8');
    expect(() => sniffFormat(raw, 'application/octet-stream')).toThrow(UploadValidationError);
  });
});
