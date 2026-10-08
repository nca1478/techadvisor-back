import { describe, expect, it } from 'vitest';
import { DocumentExtractorService, ExtractionError } from './document-extractor.service.js';

/**
 * Unit tests for source-text extraction (see ADR 0019).
 *
 * Covers HTML/Markdown/plain-text plus the failure paths. PDF success is
 * owned by `pdf-parse` itself (its own suite); here we assert that PDF magic
 * bytes route to the PDF extractor and that corrupt PDFs surface as legible
 * `ExtractionError`s instead of leaking parser internals.
 */
describe('DocumentExtractorService', () => {
  const extractor = new DocumentExtractorService();

  it('extracts headings, prose and tables from HTML without scripts', () => {
    const html = [
      '<html><head><title>Doc</title><script>alert(1)</script></head><body>',
      '<h1>Laptop X1</h1>',
      '<p>Light laptop with <strong>16 GB</strong> of RAM.</p>',
      '<table><tr><th>Spec</th><th>Value</th></tr>',
      '<tr><td>ram_gb</td><td>16</td></tr></table>',
      '</body></html>',
    ].join('');
    return expect(extractor.extract(Buffer.from(html, 'utf8'), 'text/html')).resolves.toEqual({
      text: expect.stringContaining('# Laptop X1'),
      format: 'html',
    });
  });

  it('keeps HTML tables as whole pipe rows and drops scripts', async () => {
    const html =
      '<html><body><script>evil()</script><table><tr><td>a</td><td>b</td></tr></table></body></html>';
    const { text } = await extractor.extract(Buffer.from(html, 'utf8'), 'text/html');
    expect(text).toContain('| a | b |');
    expect(text).not.toContain('evil()');
  });

  it('treats HTML-looking plain text as HTML', async () => {
    const { format } = await extractor.extract(Buffer.from('<p>Hello</p>', 'utf8'), 'text/plain');
    expect(format).toBe('html');
  });

  it('cleans markdown while preserving tables', async () => {
    const md = '# Guide\n\nRead [more](https://example.com/x).\n\n| a | b |\n| 1 | 2 |';
    const { text, format } = await extractor.extract(Buffer.from(md, 'utf8'), 'text/markdown');
    expect(format).toBe('markdown');
    expect(text).toContain('# Guide');
    expect(text).toContain('Read more.');
    expect(text).toContain('| a | b |');
  });

  it('passes plain text through with whitespace normalization', async () => {
    const { text, format } = await extractor.extract(
      Buffer.from('line one\r\n\r\n\r\nline two', 'utf8'),
      'text/plain',
    );
    expect(format).toBe('text');
    expect(text).toBe('line one\n\nline two');
  });

  it('routes PDF magic bytes to the PDF extractor', async () => {
    const fakePdf = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.from([0, 1, 2, 3])]);
    await expect(extractor.extract(fakePdf, 'application/octet-stream')).rejects.toThrow(
      ExtractionError,
    );
    await expect(extractor.extract(fakePdf, 'application/octet-stream')).rejects.toThrow(/pdf/);
  });

  it('rejects empty files with a legible error', async () => {
    await expect(extractor.extract(Buffer.alloc(0), 'text/plain')).rejects.toThrow(/empty file/);
  });

  it('rejects files with no readable text', async () => {
    await expect(extractor.extract(Buffer.from('   \n  ', 'utf8'), 'text/plain')).rejects.toThrow(
      /no readable text/,
    );
  });

  it('rejects unsupported content types without sniffing them as text', async () => {
    await expect(
      extractor.extract(Buffer.from('binary', 'utf8'), 'application/vnd.ms-excel'),
    ).rejects.toThrow(/unsupported content type/);
  });
});
