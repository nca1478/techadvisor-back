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
    const rows = await this.prisma.product.findMany({
      where: { id: { in: input.productIds } },
      include: { category: { select: { slug: true } } },
    });
    const found = new Set(rows.map((row) => row.id));
    const missing = input.productIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new NotFoundException({ message: `Products not found: ${missing.join(', ')}` });
    }
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    // Preserve request order so engine output is deterministic per request.
    const products = input.productIds.map((id) => {
      const row = byId.get(id);
      if (row === undefined) {
        throw new NotFoundException({ message: `Products not found: ${id}` });
      }
      return {
        id: row.id,
        name: row.name,
        categorySlug: row.category.slug,
        specs: (row.specs ?? {}) as Record<string, unknown>,
      };
    });

    const requested = input.locale ?? this.config.DEFAULT_LOCALE;
    const supported = this.config.SUPPORTED_LOCALES.includes(requested)
      ? requested
      : this.config.DEFAULT_LOCALE;
    return checkCompatibility(products, resolveCompatibilityLocale(supported));
  }
}
