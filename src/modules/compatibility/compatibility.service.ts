import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CompatibilityCheckInput } from './compatibility.schemas.js';
import type { CompatibilityResult } from './rules/compatibility.types.js';
import { checkCompatibility } from './rules/rules.js';
import { resolveCompatibilityLocale } from './rules/messages.js';

/**
 * Compatibility check orchestration (no LLM anywhere in this module).
 *
 * Thin by design: hydrates the requested products from SQL (id, name,
 * category slug, raw specs — any status, so admins can check DRAFT builds
 * too), resolves the message locale and delegates to the pure
 * `checkCompatibility` engine. Unknown ids 404 with the missing ids listed.
 */
@Injectable()
export class CompatibilityService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(input: CompatibilityCheckInput): Promise<CompatibilityResult> {
    // Quantity-aware: `items` carries cart qty per product, legacy
    // `productIds` means qty 1. When both list the same id, `items` wins.
    const qtyById = new Map<string, number>();
    for (const id of input.productIds ?? []) {
      if (!qtyById.has(id)) qtyById.set(id, 1);
    }
    for (const item of input.items ?? []) {
      qtyById.set(item.productId, item.qty);
    }
    const distinctIds = [...qtyById.keys()];
    const rows = await this.prisma.product.findMany({
      where: { id: { in: distinctIds } },
      include: { category: { select: { slug: true } } },
    });
    const found = new Set(rows.map((row) => row.id));
    const missing = distinctIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundException({ message: `Products not found: ${missing.join(', ')}` });
    }
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    // Preserve request order so engine output is deterministic per request,
    // expanding each product by its cart qty so slot/capacity/wattage rules
    // count every unit (e.g. 3x SATA on a 2-port board must fail).
    const orderedIds =
      (input.items ?? []).length > 0
        ? (input.items ?? []).map((item) => item.productId)
        : [...(input.productIds ?? [])];
    for (const id of distinctIds) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }
    const products = orderedIds.flatMap((id) => {
      const row = byId.get(id);
      if (row === undefined) {
        throw new NotFoundException({ message: `Products not found: ${id}` });
      }
      const qty = qtyById.get(id) ?? 1;
      const base = {
        id: row.id,
        name: row.name,
        categorySlug: row.category.slug,
        specs: (row.specs ?? {}) as Record<string, unknown>,
      };
      return Array.from({ length: qty }, () => ({ ...base }));
    });

    const requested = input.locale ?? this.config.DEFAULT_LOCALE;
    const supported = this.config.SUPPORTED_LOCALES.includes(requested)
      ? requested
      : this.config.DEFAULT_LOCALE;
    const result = checkCompatibility(products, resolveCompatibilityLocale(supported));
    // Expansion repeats the same id: dedupe per issue for stable display/links.
    return {
      compatible: result.compatible,
      issues: result.issues.map((issue) => ({
        ...issue,
        productIds: [...new Set(issue.productIds)],
      })),
    };
  }
}
