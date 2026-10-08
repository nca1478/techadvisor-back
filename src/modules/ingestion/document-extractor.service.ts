import { Injectable } from '@nestjs/common';
import { load } from 'cheerio';
import { PDFParse } from 'pdf-parse';
import { cleanMarkdownText, cleanPlainText } from './text-cleaner.js';

/**
 * Source-text extraction for the ingestion pipeline (see ADR 0019).
 *
 * Supported inputs: PDF (`pdf-parse`), HTML (`cheerio`), Markdown and plain
 * text (no library — deterministic cleaners in `text-cleaner.ts`). The only
 * file in the codebase allowed to import these libraries.
 *
 * Document bytes are treated as **untrusted data**: extraction copies text
 * out and never interprets embedded instructions; failures surface as
 * legible `ExtractionError`s carrying the format and reason only.
 */

export type SourceFormat = 'pdf' | 'html' | 'markdown' | 'text';

export interface ExtractedSource {
  text: string;
  format: SourceFormat;
}

const PDF_MAGIC = Buffer.from('%PDF-');

export class ExtractionError extends Error {
  readonly format: string;

  constructor(format: string, reason: string, options: { cause?: unknown } = {}) {
    super(`Could not extract text from ${format} document: ${reason}`);
    this.name = 'ExtractionError';
    this.format = format;
    // Low-level cause for logs; the message above stays user-legible.
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

@Injectable()
export class DocumentExtractorService {
  /**
   * Extracts cleaned text from raw source bytes. `contentType` is the upload
   * MIME type when known (e.g. `application/pdf`, `text/markdown`); PDF
   * magic bytes win over the declared type so mislabeled uploads still work.
   */
  async extract(raw: Buffer, contentType?: string): Promise<ExtractedSource> {
    if (raw.length === 0) {
      throw new ExtractionError(contentType ?? 'unknown', 'empty file');
    }
    const format = this.detectFormat(raw, contentType);
    const text =
      format === 'pdf'
        ? await this.extractPdf(raw)
        : format === 'html'
          ? this.extractHtml(raw)
          : format === 'markdown'
            ? cleanMarkdownText(raw.toString('utf8'))
            : cleanPlainText(raw.toString('utf8'));
    if (text.length === 0) {
      throw new ExtractionError(format, 'no readable text found');
    }
    return { text, format };
  }

  /** Resolves the source format from magic bytes, then the MIME type. */
  detectFormat(raw: Buffer, contentType?: string): SourceFormat {
    if (raw.length >= PDF_MAGIC.length && raw.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      return 'pdf';
    }
    const mime = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
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
    throw new ExtractionError(
      mime,
      'unsupported content type (expected PDF, HTML, Markdown or plain text)',
    );
  }

  private async extractPdf(raw: Buffer): Promise<string> {
    let parser: PDFParse | null = null;
    try {
      parser = new PDFParse({ data: new Uint8Array(raw) });
      const result = await parser.getText();
      return cleanPlainText(result.text);
    } catch (error) {
      throw new ExtractionError('pdf', this.errorReason(error), { cause: error });
    } finally {
      // `destroy` frees the worker; never let cleanup mask the real error.
      await parser?.destroy().catch(() => undefined);
    }
  }

  private extractHtml(raw: Buffer): string {
    try {
      const $ = load(raw.toString('utf8'));
      $('script, style, noscript, template').remove();
      // Tables become markdown rows so the chunker can keep them whole.
      $('table').each((_, table) => {
        const rows: string[] = [];
        $(table)
          .find('tr')
          .each((_, row) => {
            const cells: string[] = [];
            $(row)
              .find('th, td')
              .each((_, cell) => {
                cells.push($(cell).text().trim().replace(/\s+/g, ' '));
              });
            if (cells.length > 0) {
              rows.push(`| ${cells.join(' | ')} |`);
            }
          });
        $(table).replaceWith(`\n${rows.join('\n')}\n`);
      });
      $('h1, h2, h3, h4, h5, h6').each((_, heading) => {
        const level = Number(heading.tagName.slice(1));
        const hashes = '#'.repeat(Number.isInteger(level) ? Math.min(Math.max(level, 1), 6) : 1);
        $(heading).prepend(`${hashes} `);
      });
      $('li').each((_, item) => {
        $(item).prepend('- ');
      });
      $('p, div, section, article, header, footer, blockquote, pre, li, br').append('\n');
      $('h1, h2, h3, h4, h5, h6').append('\n');
      return cleanMarkdownText($.text());
    } catch (error) {
      throw new ExtractionError('html', this.errorReason(error), { cause: error });
    }
  }

  private errorReason(error: unknown): string {
    if (error instanceof ExtractionError) {
      return error.message;
    }
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.slice(0, 200);
    }
    return 'unknown parsing failure';
  }
}
