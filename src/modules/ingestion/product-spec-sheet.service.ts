import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AUTO_PRODUCT_SOURCE } from './ingestion.constants.js';
import { IngestionService } from './ingestion.service.js';

/**
 * Auto-generated SPEC_SHEET per ACTIVE product (see ADR 0019).
 *
 * `syncProduct` upserts the single `source = 'auto:product'` document for a
 * product (readable markdown from name + description + specs table) and
 * enqueues it; non-ACTIVE products get the auto document deleted so stale
 * specs never pollute retrieval. It never throws — ingestion must not break
 * product writes — and the corpus only ever contains catalog text (no user
 * PII by construction: the only input is the product row).
 */

@Injectable()
export class ProductSpecSheetService {
  private readonly logger = new Logger(ProductSpecSheetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: IngestionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Upserts + enqueues (or removes, for non-ACTIVE) the auto SPEC_SHEET. */
  async syncProduct(productId: string): Promise<void> {
    try {
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
        include: { brand: { select: { name: true } }, category: { select: { name: true } } },
      });
      if (product === null) {
        return;
      }
      if (product.status !== 'ACTIVE') {
        await this.prisma.document.deleteMany({
          where: { productId, source: AUTO_PRODUCT_SOURCE },
        });
        return;
      }
      const text = buildSpecSheetText(product);
      const title = `Spec sheet: ${product.name}`;
      const locale = this.config.DEFAULT_LOCALE;

      let documentId: string;
      const existing = await this.prisma.document.findFirst({
        where: { productId, source: AUTO_PRODUCT_SOURCE },
        select: { id: true },
      });
      if (existing) {
        const updated = await this.prisma.document.update({
          where: { id: existing.id },
          data: {
            type: 'SPEC_SHEET',
            title,
            locale,
            categoryId: product.categoryId,
            status: 'PENDING',
            error: null,
          },
          select: { id: true },
        });
        documentId = updated.id;
      } else {
        try {
          const created = await this.prisma.document.create({
            data: {
              productId,
              categoryId: product.categoryId,
              type: 'SPEC_SHEET',
              title,
              locale,
              source: AUTO_PRODUCT_SOURCE,
              contentHash: 'pending',
              status: 'PENDING',
            },
            select: { id: true },
          });
          documentId = created.id;
        } catch {
          // Lost a create race (unique productId+source): re-read the winner.
          const winner = await this.prisma.document.findFirst({
            where: { productId, source: AUTO_PRODUCT_SOURCE },
            select: { id: true },
          });
          if (!winner) {
            throw new Error('auto SPEC_SHEET document vanished after unique conflict');
          }
          documentId = winner.id;
        }
      }
      await this.ingestion.enqueueDocument(
        documentId,
        Buffer.from(text, 'utf8'),
        SPEC_SHEET_MARKDOWN_TYPE,
      );
    } catch (error) {
      this.logger.warn(
        `Skipping SPEC_SHEET sync for product ${productId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

export const SPEC_SHEET_MARKDOWN_TYPE = 'text/markdown';

/**
 * Renders a product row as readable markdown. Key order is sorted so the
 * output (and therefore the content hash) is stable across re-syncs —
 * re-syncing an unchanged product must not reprocess it.
 */
export function buildSpecSheetText(product: {
  name: string;
  description: string;
  sku: string;
  specs: unknown;
  brand: { name: string };
  category: { name: string };
}): string {
  const lines = [`# ${product.name}`, '', product.description.trim(), '', '## Details', ''];
  lines.push(`- Brand: ${product.brand.name}`);
  lines.push(`- Category: ${product.category.name}`);
  lines.push(`- SKU: ${product.sku}`);
  const specs = toSpecEntries(product.specs);
  if (specs.length > 0) {
    lines.push('', '## Specifications', '', '| Spec | Value |', '| --- | --- |');
    for (const [key, value] of specs) {
      lines.push(`| ${key} | ${value} |`);
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

function toSpecEntries(specs: unknown): Array<[string, string]> {
  if (specs === null || typeof specs !== 'object' || Array.isArray(specs)) {
    return [];
  }
  return Object.keys(specs as Record<string, unknown>)
    .sort()
    .map((key): [string, string] => [
      key,
      formatSpecValue((specs as Record<string, unknown>)[key]),
    ]);
}

function formatSpecValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // JSON.stringify is typed as always-string but returns undefined at
  // runtime for undefined/functions/symbols — guard explicitly.
  const json: unknown = JSON.stringify(value);
  return typeof json === 'string' ? json : 'null';
}
