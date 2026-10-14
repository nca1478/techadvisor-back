import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seedDocumentSource, seedDocumentTitle, specSheetTitle } from './seed-documents.js';

const CONTENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'content');

describe('seed:documents helpers', () => {
  it('builds stable provenance keys', () => {
    expect(seedDocumentSource('seed:faq', 'es', 'general')).toBe('seed:faq:es:general');
    expect(seedDocumentSource('seed:warranty', 'en', 'coverage')).toBe('seed:warranty:en:coverage');
    expect(seedDocumentSource('seed:policy', 'es', 'garantia')).toBe('seed:policy:es:garantia');
  });

  it('titles from the first heading, falling back to the slug', () => {
    expect(seedDocumentTitle('# My title — TEMPLATE\n\nBody', 'slug')).toBe('My title');
    expect(seedDocumentTitle('no heading here', 'fallback-slug')).toBe('fallback-slug');
  });

  it('titles spec sheets like the catalog hook', () => {
    expect(specSheetTitle('Laptop X1')).toBe('Spec sheet: Laptop X1');
  });
});

describe('seed:documents corpus files', () => {
  const groups = [
    { dir: 'policies', minFiles: 4 },
    { dir: 'faqs', minFiles: 2 },
    { dir: 'warranty', minFiles: 2 },
  ] as const;
  for (const group of groups) {
    it(`${group.dir}/ has es+en markdowns with headings`, async () => {
      for (const locale of ['es', 'en']) {
        const dir = join(CONTENT_ROOT, group.dir, locale);
        const files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort();
        expect(files.length).toBeGreaterThanOrEqual(group.minFiles);
        for (const file of files) {
          const markdown = await readFile(join(dir, file), 'utf8');
          expect(markdown).toMatch(/^# .+/m);
        }
      }
    });
  }
});
