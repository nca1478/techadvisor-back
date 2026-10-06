import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CatalogQuery } from './catalog-query.schema.js';
import {
  type CatalogBrandDto,
  type CatalogCategoryDto,
  type PaginatedProductsDto,
  type PaginationMetaDto,
  type ProductDetailDto,
  type ProductListItemDto,
  type SpecFieldDto,
} from './dto/catalog.dto.js';
import { getSpecsFields } from './specs/index.js';

export type ProductSort = CatalogQuery['sort'];

// --- Pure helpers (exported for unit tests; no database access) ---------------

/** Resolves the requested locale, falling back to the default when missing/unsupported. */
export function resolveLocale(
  requested: string | undefined,
  supportedLocales: readonly string[],
  defaultLocale: string,
): string {
  if (requested && supportedLocales.includes(requested)) {
    return requested;
  }
  return defaultLocale;
}

/** Picks the translated text when present, else the default-locale base text. */
export function pickLocalizedText<T extends { locale: string }>(
  translations: readonly T[],
  locale: string,
  pick: (row: T) => string,
  fallback: string,
): string {
  const row = translations.find((translation) => translation.locale === locale);
  return row ? pick(row) : fallback;
}

/** Resolves the display price: fixed override in the requested currency, else base. */
export function resolvePrice(
  base: { amount: number; currency: string },
  overrides: readonly { currency: string; amount: number }[],
  requestedCurrency: string,
): { amount: number; currency: string } {
  const override = overrides.find((row) => row.currency === requestedCurrency);
  if (override) {
    return { amount: override.amount, currency: override.currency };
  }
  return { amount: base.amount, currency: base.currency };
}

export interface PriceRange {
  minPrice?: number;
  maxPrice?: number;
}

/**
 * Builds the Prisma `where` for the public product list. Only `ACTIVE`
 * products ever match. Price bounds apply to the price **in the requested
 * currency** (base row or fixed override — see ADR 0007); products with no
 * price in that currency are excluded from range-filtered queries.
 */
export function buildProductWhere(filters: {
  category?: string;
  brand?: string;
  q?: string;
  currency: string;
  minPrice?: number;
  maxPrice?: number;
}): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = { status: 'ACTIVE' };

  if (filters.category) {
    where.category = { slug: filters.category };
  }
  if (filters.brand) {
    where.brand = { slug: filters.brand };
  }
  if (filters.q) {
    const query = filters.q;
    where.OR = [
      { name: { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
      { translations: { some: { name: { contains: query, mode: 'insensitive' } } } },
    ];
  }
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    const range: { gte?: number; lte?: number } = {};
    if (filters.minPrice !== undefined) {
      range.gte = filters.minPrice;
    }
    if (filters.maxPrice !== undefined) {
      range.lte = filters.maxPrice;
    }
    where.AND = [
      {
        OR: [
          { currency: filters.currency, priceAmount: range },
          { prices: { some: { currency: filters.currency, amount: range } } },
        ],
      },
    ];
  }
  return where;
}

/** Deterministic ordering (id tiebreak keeps pages stable). */
export function buildProductOrderBy(sort: ProductSort): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'price_asc':
      return [{ priceAmount: 'asc' }, { id: 'asc' }];
    case 'price_desc':
      return [{ priceAmount: 'desc' }, { id: 'asc' }];
    case 'name_asc':
      return [{ name: 'asc' }, { id: 'asc' }];
    case 'name_desc':
      return [{ name: 'desc' }, { id: 'asc' }];
    case 'newest':
      return [{ createdAt: 'desc' }, { id: 'asc' }];
  }
}

export function toPaginationMeta(page: number, limit: number, total: number): PaginationMetaDto {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

// --- Prisma row shapes used by the mappers ------------------------------------

type ProductListRow = Prisma.ProductGetPayload<{
  include: {
    brand: true;
    category: { include: { parent: { select: { slug: true } }; translations: true } };
    images: true;
    prices: true;
    translations: true;
  };
}>;

type CategoryRow = Prisma.CategoryGetPayload<{
  include: { parent: { select: { slug: true } }; translations: true };
}>;

// --- Service -----------------------------------------------------------------

/**
 * Public read-only catalog. Thin orchestration over Prisma: every query is
 * scoped to `ACTIVE` products, prices resolve per ADR 0007 and texts per
 * ADR 0008. No stock is exposed here (arrives in P1.3).
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private requestedCurrency(currency: string | undefined): string {
    const requested = currency ?? this.config.BASE_CURRENCY;
    if (!this.config.SUPPORTED_CURRENCIES.includes(requested)) {
      throw new BadRequestException({
        message: `Unsupported currency "${requested}". Supported: ${this.config.SUPPORTED_CURRENCIES.join(', ')}`,
      });
    }
    return requested;
  }

  private resolvedLocale(locale: string | undefined): string {
    return resolveLocale(locale, this.config.SUPPORTED_LOCALES, this.config.DEFAULT_LOCALE);
  }

  async listProducts(query: CatalogQuery): Promise<PaginatedProductsDto> {
    const currency = this.requestedCurrency(query.currency);
    const locale = this.resolvedLocale(query.locale);
    const where = buildProductWhere({
      category: query.category,
      brand: query.brand,
      q: query.q,
      currency,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
    });
    const skip = (query.page - 1) * query.limit;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: buildProductOrderBy(query.sort),
        skip,
        take: query.limit,
        include: {
          brand: true,
          category: {
            include: {
              parent: { select: { slug: true } },
              translations: { where: { locale } },
            },
          },
          images: { orderBy: { position: 'asc' } },
          prices: { where: { currency } },
          translations: { where: { locale } },
        },
      }),
    ]);

    return {
      data: rows.map((row) => this.toListItem(row, locale, currency)),
      meta: toPaginationMeta(query.page, query.limit, total),
    };
  }

  async getProductBySlug(
    slug: string,
    localeInput: string | undefined,
    currencyInput: string | undefined,
  ): Promise<ProductDetailDto> {
    const currency = this.requestedCurrency(currencyInput);
    const locale = this.resolvedLocale(localeInput);
    const row = await this.prisma.product.findFirst({
      where: { slug, status: 'ACTIVE' },
      include: {
        brand: true,
        category: {
          include: {
            parent: { select: { slug: true } },
            translations: { where: { locale } },
          },
        },
        images: { orderBy: { position: 'asc' } },
        prices: { where: { currency } },
        translations: { where: { locale } },
      },
    });
    if (!row) {
      // DRAFT/ARCHIVED slugs 404 identically to unknown slugs so the
      // public API never reveals non-active products.
      throw new NotFoundException({ message: 'Product not found' });
    }
    return {
      ...this.toBaseFields(row, locale, currency),
      images: row.images.map((image) => ({
        url: image.url,
        alt: image.alt,
        position: image.position,
      })),
    };
  }

  async listCategories(localeInput: string | undefined): Promise<CatalogCategoryDto[]> {
    const locale = this.resolvedLocale(localeInput);
    const rows = await this.prisma.category.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: {
        parent: { select: { slug: true } },
        translations: { where: { locale } },
      },
    });
    return rows.map((row) => this.toCategory(row, locale));
  }

  async getCategoryBySlug(
    slug: string,
    localeInput: string | undefined,
  ): Promise<CatalogCategoryDto> {
    const locale = this.resolvedLocale(localeInput);
    const row = await this.prisma.category.findUnique({
      where: { slug },
      include: {
        parent: { select: { slug: true } },
        translations: { where: { locale } },
      },
    });
    if (!row) {
      throw new NotFoundException({ message: 'Category not found' });
    }
    return this.toCategory(row, locale);
  }

  async listBrands(): Promise<CatalogBrandDto[]> {
    const rows = await this.prisma.brand.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    return rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug }));
  }

  private toCategory(row: CategoryRow, locale: string): CatalogCategoryDto {
    return {
      id: row.id,
      name: pickLocalizedText(row.translations, locale, (row) => row.name, row.name),
      slug: row.slug,
      parentSlug: row.parent?.slug ?? null,
      specsSchema: getSpecsFields(row.slug).map((field): SpecFieldDto => ({
        key: field.key,
        label: field.label,
        type: field.type,
        ...(field.unit !== undefined ? { unit: field.unit } : {}),
        ...(field.options !== undefined ? { options: [...field.options] } : {}),
      })),
      locale,
    };
  }

  private toListItem(row: ProductListRow, locale: string, currency: string): ProductListItemDto {
    const primary = row.images.length > 0 ? row.images[0] : null;
    return {
      ...this.toBaseFields(row, locale, currency),
      imageUrl: primary?.url ?? null,
      // When the image has no alt, clients fall back to the product name.
      imageAlt: primary?.alt ?? null,
    };
  }

  private toBaseFields(
    row: ProductListRow,
    locale: string,
    currency: string,
  ): Omit<ProductListItemDto, 'imageUrl' | 'imageAlt'> {
    const price = resolvePrice(
      { amount: row.priceAmount, currency: row.currency },
      row.prices,
      currency,
    );
    return {
      id: row.id,
      sku: row.sku,
      name: pickLocalizedText(
        row.translations,
        locale,
        (translation) => translation.name,
        row.name,
      ),
      slug: row.slug,
      description: pickLocalizedText(
        row.translations,
        locale,
        (translation) => translation.description,
        row.description,
      ),
      brand: { id: row.brand.id, name: row.brand.name, slug: row.brand.slug },
      category: this.toCategory(row.category, locale),
      priceAmount: price.amount,
      currency: price.currency,
      specs: (row.specs ?? {}) as Record<string, unknown>,
      locale,
      createdAt: row.createdAt,
    };
  }
}
