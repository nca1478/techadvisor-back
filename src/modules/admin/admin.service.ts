import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { OrderStatus, Prisma } from '../../generated/prisma/client.js';
import { Prisma as PrismaNamespace } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { parseSpecs } from '../catalog/specs/index.js';
import { ProductSpecSheetService } from '../ingestion/product-spec-sheet.service.js';
import { OrderNotFoundException } from '../orders/orders.errors.js';
import { OrdersService } from '../orders/orders.service.js';
import type {
  AdminOrderListDto,
  AdminOrderDto,
  AdminProductDto,
  AdminProductListDto,
} from './dto/admin.dto.js';
import type {
  AdjustInventoryInput,
  AdminOrderListQuery,
  AdminProductListQuery,
  CreateBrandInput,
  CreateCategoryInput,
  CreateProductInput,
  ReplaceProductImagesInput,
  UpdateBrandInput,
  UpdateCategoryInput,
  UpdateProductInput,
} from './admin.schemas.js';

type AdminProductRow = Prisma.ProductGetPayload<{
  include: {
    brand: true;
    category: { select: { slug: true } };
    images: true;
    prices: true;
    translations: true;
    inventory: true;
  };
}>;

type AdminOrderRow = Prisma.OrderGetPayload<{
  include: {
    items: { include: { product: { select: { name: true; slug: true } } } };
  };
}>;

/**
 * Back-office writes (see ADR 0013). Every route using this service sits
 * behind `JwtAuthGuard + @Roles('ADMIN')`.
 *
 * - Products are never physically deleted: archival is a status change, so
 *   `OrderItem` rows (frozen prices + a live product join for names) keep
 *   working after `ARCHIVED`.
 * - Base prices are always written in `BASE_CURRENCY`; other currencies are
 *   fixed override rows (ADR 0007). Base texts hold `DEFAULT_LOCALE`;
 *   translations hold other supported locales only (ADR 0008).
 * - `specs` is validated against the Zod schema of the effective category.
 * - Every stock adjustment appends exactly one `InventoryMovement` row.
 * - Order status changes go through `OrdersService.transitionOrder`, so the
 *   state machine is enforced in one place; transitions into `PAID` are
 *   rejected here (only the Stripe webhook marks orders as paid).
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly specSheets: ProductSpecSheetService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // --- Products ------------------------------------------------------------

  async listProducts(query: AdminProductListQuery): Promise<AdminProductListDto> {
    const where: Prisma.ProductWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.category !== undefined) {
      where.category = { slug: query.category };
    }
    if (query.brand !== undefined) {
      where.brand = { slug: query.brand };
    }
    if (query.q !== undefined) {
      const text = query.q;
      where.OR = [
        { name: { contains: text, mode: 'insensitive' } },
        { sku: { contains: text, mode: 'insensitive' } },
        { slug: { contains: text, mode: 'insensitive' } },
      ];
    }
    const skip = (query.page - 1) * query.limit;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
        include: {
          brand: true,
          category: { select: { slug: true } },
          images: { orderBy: { position: 'asc' } },
          prices: true,
          translations: true,
          inventory: true,
        },
      }),
    ]);
    return {
      data: rows.map((row) => this.toAdminProduct(row)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  async getProductById(id: string): Promise<AdminProductDto> {
    return this.toAdminProduct(await this.findProductOrThrow(id));
  }

  async createProduct(input: CreateProductInput): Promise<AdminProductDto> {
    const brand = await this.prisma.brand.findUnique({ where: { id: input.brandId } });
    if (brand === null) {
      throw new NotFoundException({ message: `Brand "${input.brandId}" not found` });
    }
    const category = await this.prisma.category.findUnique({ where: { id: input.categoryId } });
    if (category === null) {
      throw new NotFoundException({ message: `Category "${input.categoryId}" not found` });
    }
    this.assertBaseCurrency(input.currency);
    this.assertSupportedPrices(input.prices);
    this.assertSupportedTranslations(input.translations.map((translation) => translation.locale));
    const specs = this.parseSpecsOrThrow(category.slug, input.specs);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            sku: input.sku,
            name: input.name,
            slug: input.slug,
            description: input.description,
            brandId: input.brandId,
            categoryId: input.categoryId,
            priceAmount: input.priceAmount,
            currency: input.currency,
            status: input.status,
            specs,
            prices: {
              create: input.prices.map((price) => ({
                currency: price.currency,
                amount: price.amount,
              })),
            },
            translations: {
              create: input.translations.map((translation) => ({ ...translation })),
            },
            images: {
              create: input.images.map((image, index) => ({
                url: image.url,
                alt: image.alt ?? null,
                position: index,
              })),
            },
            inventory: { create: { stock: input.initialStock, reserved: 0 } },
          },
          include: {
            brand: true,
            category: { select: { slug: true } },
            images: { orderBy: { position: 'asc' } },
            prices: true,
            translations: true,
            inventory: true,
          },
        });
        if (input.initialStock > 0) {
          await tx.inventoryMovement.create({
            data: {
              productId: product.id,
              delta: input.initialStock,
              reason: 'Initial stock on product creation',
              stockAfter: input.initialStock,
            },
          });
        }
        return product;
      });
      // Fire-and-forget SPEC_SHEET auto-ingest (never throws; a queue outage
      // leaves the document PENDING for a later sync — see ADR 0019).
      void this.specSheets.syncProduct(created.id);
      return this.toAdminProduct(created);
    } catch (error) {
      throw this.toUniqueConflict(error, 'sku or slug');
    }
  }

  async updateProduct(id: string, input: UpdateProductInput): Promise<AdminProductDto> {
    const current = await this.findProductOrThrow(id);

    if (input.brandId !== undefined) {
      const brand = await this.prisma.brand.findUnique({ where: { id: input.brandId } });
      if (brand === null) {
        throw new NotFoundException({ message: `Brand "${input.brandId}" not found` });
      }
    }
    let categorySlug = current.category.slug;
    if (input.categoryId !== undefined) {
      const category = await this.prisma.category.findUnique({
        where: { id: input.categoryId },
      });
      if (category === null) {
        throw new NotFoundException({ message: `Category "${input.categoryId}" not found` });
      }
      categorySlug = category.slug;
    }
    // Specs always validated against the effective category: a category
    // change re-validates the stored specs so they can never go stale.
    const specs =
      input.specs !== undefined
        ? this.parseSpecsOrThrow(categorySlug, input.specs)
        : input.categoryId !== undefined
          ? this.parseSpecsOrThrow(categorySlug, current.specs ?? {})
          : undefined;
    if (input.currency !== undefined) {
      this.assertBaseCurrency(input.currency);
    }
    if (input.prices !== undefined) {
      this.assertSupportedPrices(input.prices);
    }
    if (input.translations !== undefined) {
      this.assertSupportedTranslations(input.translations.map((translation) => translation.locale));
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        if (input.prices !== undefined) {
          await tx.productPrice.deleteMany({ where: { productId: id } });
          if (input.prices.length > 0) {
            await tx.productPrice.createMany({
              data: input.prices.map((price) => ({
                productId: id,
                currency: price.currency,
                amount: price.amount,
              })),
            });
          }
        }
        if (input.translations !== undefined) {
          await tx.productTranslation.deleteMany({ where: { productId: id } });
          if (input.translations.length > 0) {
            await tx.productTranslation.createMany({
              data: input.translations.map((translation) => ({
                productId: id,
                locale: translation.locale,
                name: translation.name,
                description: translation.description,
              })),
            });
          }
        }
        return tx.product.update({
          where: { id },
          data: {
            ...(input.sku !== undefined ? { sku: input.sku } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.brandId !== undefined ? { brand: { connect: { id: input.brandId } } } : {}),
            ...(input.categoryId !== undefined
              ? { category: { connect: { id: input.categoryId } } }
              : {}),
            ...(input.priceAmount !== undefined ? { priceAmount: input.priceAmount } : {}),
            ...(input.currency !== undefined ? { currency: input.currency } : {}),
            ...(specs !== undefined ? { specs } : {}),
          },
          include: {
            brand: true,
            category: { select: { slug: true } },
            images: { orderBy: { position: 'asc' } },
            prices: true,
            translations: true,
            inventory: true,
          },
        });
      });
      void this.specSheets.syncProduct(updated.id);
      return this.toAdminProduct(updated);
    } catch (error) {
      throw this.toUniqueConflict(error, 'sku or slug');
    }
  }

  async updateProductStatus(id: string, status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED') {
    await this.findProductOrThrow(id);
    const updated = await this.prisma.product.update({
      where: { id },
      data: { status },
      include: {
        brand: true,
        category: { select: { slug: true } },
        images: { orderBy: { position: 'asc' } },
        prices: true,
        translations: true,
        inventory: true,
      },
    });
    // Archival removes the auto SPEC_SHEET; (re)activation regenerates it.
    void this.specSheets.syncProduct(updated.id);
    return this.toAdminProduct(updated);
  }

  /**
   * Replaces the complete image set transactionally. Positions are
   * reassigned `0..n-1` in list order, so reordering is a plain PUT with
   * the same URLs in a new order.
   */
  async replaceProductImages(
    id: string,
    input: ReplaceProductImagesInput,
  ): Promise<AdminProductDto> {
    await this.findProductOrThrow(id);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.productImage.deleteMany({ where: { productId: id } });
      if (input.images.length > 0) {
        await tx.productImage.createMany({
          data: input.images.map((image, index) => ({
            productId: id,
            url: image.url,
            alt: image.alt ?? null,
            position: index,
          })),
        });
      }
      return tx.product.findUniqueOrThrow({
        where: { id },
        include: {
          brand: true,
          category: { select: { slug: true } },
          images: { orderBy: { position: 'asc' } },
          prices: true,
          translations: true,
          inventory: true,
        },
      });
    });
    return this.toAdminProduct(updated);
  }

  // --- Categories ----------------------------------------------------------

  async listCategories() {
    return this.prisma.category.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: { translations: true },
    });
  }

  /**
   * Single category for the back-office edit screen. Same shape as the
   * list rows (`AdminCategoryDto`); 404s on unknown ids so the frontend
   * can render its not-found page.
   */
  async getCategoryById(id: string) {
    const row = await this.prisma.category.findUnique({
      where: { id },
      include: { translations: true },
    });
    if (row === null) {
      throw new NotFoundException({ message: 'Category not found' });
    }
    return row;
  }

  async createCategory(input: CreateCategoryInput) {
    if (input.parentId !== undefined) {
      await this.findCategoryOrThrow(input.parentId);
    }
    this.assertSupportedTranslations(input.translations.map((translation) => translation.locale));
    try {
      return await this.prisma.category.create({
        data: {
          name: input.name,
          slug: input.slug,
          parentId: input.parentId ?? null,
          translations: { create: input.translations.map((translation) => ({ ...translation })) },
        },
        include: { translations: true },
      });
    } catch (error) {
      throw this.toUniqueConflict(error, 'slug');
    }
  }

  async updateCategory(id: string, input: UpdateCategoryInput) {
    await this.findCategoryOrThrow(id);
    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === id) {
        throw new BadRequestException({ message: 'A category cannot be its own parent' });
      }
      await this.findCategoryOrThrow(input.parentId);
      await this.assertNoCategoryCycle(id, input.parentId);
    }
    if (input.translations !== undefined) {
      this.assertSupportedTranslations(input.translations.map((translation) => translation.locale));
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (input.translations !== undefined) {
          await tx.categoryTranslation.deleteMany({ where: { categoryId: id } });
          if (input.translations.length > 0) {
            await tx.categoryTranslation.createMany({
              data: input.translations.map((translation) => ({
                categoryId: id,
                locale: translation.locale,
                name: translation.name,
              })),
            });
          }
        }
        return tx.category.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          },
          include: { translations: true },
        });
      });
    } catch (error) {
      throw this.toUniqueConflict(error, 'slug');
    }
  }

  async deleteCategory(id: string): Promise<void> {
    await this.findCategoryOrThrow(id);
    const [children, products] = await this.prisma.$transaction([
      this.prisma.category.count({ where: { parentId: id } }),
      this.prisma.product.count({ where: { categoryId: id } }),
    ]);
    if (children > 0 || products > 0) {
      throw new ConflictException({
        message: 'Category cannot be deleted while it has subcategories or products',
        details: { subcategories: children, products },
      });
    }
    await this.prisma.category.delete({ where: { id } });
  }

  // --- Brands --------------------------------------------------------------

  async listBrands() {
    return this.prisma.brand.findMany({ orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  }

  async createBrand(input: CreateBrandInput) {
    try {
      return await this.prisma.brand.create({ data: { ...input } });
    } catch (error) {
      throw this.toUniqueConflict(error, 'slug');
    }
  }

  async updateBrand(id: string, input: UpdateBrandInput) {
    await this.findBrandOrThrow(id);
    try {
      return await this.prisma.brand.update({ where: { id }, data: { ...input } });
    } catch (error) {
      throw this.toUniqueConflict(error, 'slug');
    }
  }

  async deleteBrand(id: string): Promise<void> {
    await this.findBrandOrThrow(id);
    const products = await this.prisma.product.count({ where: { brandId: id } });
    if (products > 0) {
      throw new ConflictException({
        message: 'Brand cannot be deleted while products reference it',
        details: { products },
      });
    }
    await this.prisma.brand.delete({ where: { id } });
  }

  // --- Inventory -----------------------------------------------------------

  async getInventory(productId: string) {
    await this.findProductOrThrow(productId);
    const row = await this.prisma.inventory.findUnique({ where: { productId } });
    const stock = row?.stock ?? 0;
    const reserved = row?.reserved ?? 0;
    return { productId, stock, reserved, available: Math.max(0, stock - reserved) };
  }

  async listMovements(productId: string) {
    await this.findProductOrThrow(productId);
    return this.prisma.inventoryMovement.findMany({
      where: { productId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
  }

  /**
   * Applies a signed delta to the physical stock and appends the audit row
   * in the same transaction. Never touches `reserved`; the DB CHECKs
   * (`stock >= 0`, `reserved <= stock`) are the backstop behind the
   * pre-flight validations below.
   */
  async adjustInventory(productId: string, input: AdjustInventoryInput) {
    await this.findProductOrThrow(productId);
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.inventory.upsert({
        where: { productId },
        create: { productId, stock: 0, reserved: 0 },
        update: {},
      });
      const next = current.stock + input.delta;
      if (next < 0) {
        throw new BadRequestException({
          message: `Adjustment of ${String(input.delta)} would leave negative stock (${String(current.stock)} on hand)`,
          details: { stock: current.stock, reserved: current.reserved, delta: input.delta },
        });
      }
      if (next < current.reserved) {
        throw new ConflictException({
          message: `Adjustment of ${String(input.delta)} would leave stock (${String(next)}) below reserved units (${String(current.reserved)})`,
          details: { stock: current.stock, reserved: current.reserved, delta: input.delta },
        });
      }
      const updated = await tx.inventory.update({
        where: { productId },
        data: { stock: next },
      });
      const movement = await tx.inventoryMovement.create({
        data: { productId, delta: input.delta, reason: input.reason, stockAfter: next },
      });
      return { inventory: updated, movementId: movement.id };
    });
    const available = Math.max(0, result.inventory.stock - result.inventory.reserved);
    return {
      productId,
      stock: result.inventory.stock,
      reserved: result.inventory.reserved,
      available,
      movementId: result.movementId,
    };
  }

  // --- Orders (admin) ------------------------------------------------------

  async listOrders(query: AdminOrderListQuery): Promise<AdminOrderListDto> {
    const where: Prisma.OrderWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.userId !== undefined) {
      where.userId = query.userId;
    }
    const from = this.parseDateOrThrow(query.from, 'from');
    const to = this.parseDateOrThrow(query.to, 'to');
    if (from !== undefined || to !== undefined) {
      where.createdAt = {
        ...(from !== undefined ? { gte: from } : {}),
        ...(to !== undefined ? { lte: to } : {}),
      };
    }
    if (from !== undefined && to !== undefined && from > to) {
      throw new BadRequestException({ message: '"from" must not be after "to"' });
    }
    const skip = (query.page - 1) * query.limit;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
        include: {
          items: {
            orderBy: { createdAt: 'asc' },
            include: { product: { select: { name: true, slug: true } } },
          },
        },
      }),
    ]);
    return {
      data: rows.map((row) => this.toAdminOrder(row)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  async getOrderById(id: string): Promise<AdminOrderDto> {
    const row = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: { product: { select: { name: true, slug: true } } },
        },
      },
    });
    if (row === null) {
      throw new OrderNotFoundException();
    }
    return this.toAdminOrder(row);
  }

  async updateOrderStatus(id: string, to: OrderStatus): Promise<AdminOrderDto> {
    if (to === 'PAID') {
      // Restriction 7b: only the Stripe webhook (verified signature)
      // moves orders into PAID — never a back-office call.
      throw new UnprocessableEntityException({
        message: 'Orders can only be marked PAID by the Stripe webhook, not by admin',
      });
    }
    await this.orders.transitionOrder(id, to);
    return this.getOrderById(id);
  }

  // --- Helpers -------------------------------------------------------------

  private async findProductOrThrow(id: string) {
    const row = await this.prisma.product.findUnique({
      where: { id },
      include: {
        brand: true,
        category: { select: { slug: true } },
        images: { orderBy: { position: 'asc' } },
        prices: true,
        translations: true,
        inventory: true,
      },
    });
    if (row === null) {
      throw new NotFoundException({ message: 'Product not found' });
    }
    return row;
  }

  private async findCategoryOrThrow(id: string) {
    const row = await this.prisma.category.findUnique({ where: { id } });
    if (row === null) {
      throw new NotFoundException({ message: 'Category not found' });
    }
    return row;
  }

  private async findBrandOrThrow(id: string) {
    const row = await this.prisma.brand.findUnique({ where: { id } });
    if (row === null) {
      throw new NotFoundException({ message: 'Brand not found' });
    }
    return row;
  }

  private async assertNoCategoryCycle(categoryId: string, parentId: string): Promise<void> {
    let cursor: string | null = parentId;
    const seen = new Set<string>();
    while (cursor !== null) {
      if (cursor === categoryId) {
        throw new BadRequestException({ message: 'A category cannot descend from itself' });
      }
      if (seen.has(cursor)) {
        break;
      }
      seen.add(cursor);
      const parent: { parentId: string | null } | null = await this.prisma.category.findUnique({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = parent?.parentId ?? null;
    }
  }

  /** Base prices are always written in BASE_CURRENCY (ADR 0007). */
  private assertBaseCurrency(currency: string): void {
    if (currency !== this.config.BASE_CURRENCY) {
      throw new BadRequestException({
        message: `Base price currency must be ${this.config.BASE_CURRENCY}; use "prices" overrides for ${currency}`,
        details: { baseCurrency: this.config.BASE_CURRENCY, received: currency },
      });
    }
  }

  private assertSupportedPrices(prices: { currency: string; amount: number }[]): void {
    const seen = new Set<string>();
    for (const price of prices) {
      if (!this.config.SUPPORTED_CURRENCIES.includes(price.currency)) {
        throw new BadRequestException({
          message: `Unsupported currency "${price.currency}". Supported: ${this.config.SUPPORTED_CURRENCIES.join(', ')}`,
        });
      }
      if (price.currency === this.config.BASE_CURRENCY) {
        throw new BadRequestException({
          message: `Price override for the base currency (${this.config.BASE_CURRENCY}) is redundant: set priceAmount instead`,
        });
      }
      if (seen.has(price.currency)) {
        throw new BadRequestException({
          message: `Duplicate price override for currency "${price.currency}"`,
        });
      }
      seen.add(price.currency);
    }
  }

  /** Translations hold non-default locales only; base columns hold DEFAULT_LOCALE. */
  private assertSupportedTranslations(locales: string[]): void {
    const seen = new Set<string>();
    for (const locale of locales) {
      if (!this.config.SUPPORTED_LOCALES.includes(locale)) {
        throw new BadRequestException({
          message: `Unsupported locale "${locale}". Supported: ${this.config.SUPPORTED_LOCALES.join(', ')}`,
        });
      }
      if (locale === this.config.DEFAULT_LOCALE) {
        throw new BadRequestException({
          message: `Translation for the default locale (${this.config.DEFAULT_LOCALE}) is redundant: set the base name/description instead`,
        });
      }
      if (seen.has(locale)) {
        throw new BadRequestException({ message: `Duplicate translation for locale "${locale}"` });
      }
      seen.add(locale);
    }
  }

  private parseSpecsOrThrow(categorySlug: string, specs: unknown): Prisma.InputJsonValue {
    try {
      return parseSpecs(categorySlug, specs) as Prisma.InputJsonValue;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.issues.map(
          (issue) => `${issue.path.join('.') || 'specs'}: ${issue.message}`,
        );
        throw new BadRequestException({
          message: `Invalid specs for category "${categorySlug}": ${details.join('; ')}`,
          details,
        });
      }
      throw error;
    }
  }

  private parseDateOrThrow(value: string | undefined, field: string): Date | undefined {
    if (value === undefined) {
      return undefined;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException({ message: `"${field}" must be a valid ISO 8601 date` });
    }
    return date;
  }

  private toUniqueConflict(error: unknown, fallback: string): Error {
    if (error instanceof PrismaNamespace.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target.join(', ') : fallback;
      return new ConflictException({
        message: `A record with the same ${fields} already exists`,
        details: { fields },
      });
    }
    throw error;
  }

  private toAdminProduct(row: AdminProductRow): AdminProductDto {
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      slug: row.slug,
      description: row.description,
      brandId: row.brandId,
      categoryId: row.categoryId,
      priceAmount: row.priceAmount,
      currency: row.currency,
      status: row.status,
      specs: (row.specs ?? {}) as Record<string, unknown>,
      prices: row.prices.map((price) => ({ currency: price.currency, amount: price.amount })),
      translations: row.translations.map((translation) => ({
        locale: translation.locale,
        name: translation.name,
        description: translation.description,
      })),
      images: row.images.map((image) => ({
        url: image.url,
        alt: image.alt,
        position: image.position,
      })),
      stock: row.inventory?.stock ?? 0,
      reserved: row.inventory?.reserved ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toAdminOrder(row: AdminOrderRow): AdminOrderDto {
    return {
      id: row.id,
      userId: row.userId,
      status: row.status,
      currency: row.currency,
      totalAmount: row.totalAmount,
      items: row.items.map((item) => ({
        productId: item.productId,
        name: item.product.name,
        slug: item.product.slug,
        qty: item.qty,
        unitPriceAmount: item.unitPriceAmount,
        lineTotalAmount: item.unitPriceAmount * item.qty,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
