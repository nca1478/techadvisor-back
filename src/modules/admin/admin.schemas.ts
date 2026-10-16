import { z } from 'zod';
import { imageUrlSchema } from '../catalog/specs/index.js';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const slugSchema = z
  .string({ error: 'slug is required (lowercase alphanumeric words joined with dashes)' })
  .trim()
  .min(1, { error: 'slug must not be empty' })
  .max(100, { error: 'slug must be at most 100 characters long' })
  .regex(SLUG_PATTERN, {
    error: 'slug must be lowercase alphanumeric words joined with dashes (e.g. ultrabook-pro-14)',
  });

export const localeSchema = z
  .string({ error: 'locale is required (BCP 47, e.g. en, es)' })
  .trim()
  .regex(LOCALE_PATTERN, { error: 'locale must be BCP 47 (e.g. en, es)' });

export const currencySchema = z
  .string({ error: 'currency is required (3-letter ISO 4217 code, e.g. USD)' })
  .trim()
  .toUpperCase()
  .regex(CURRENCY_PATTERN, { error: 'currency must be a 3-letter ISO 4217 code (e.g. USD)' });

export const uuidParamsSchema = z.object({
  id: z.uuid({ error: 'id must be a valid UUID' }),
});

export type UuidParams = z.output<typeof uuidParamsSchema>;

export const productStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);

export type ProductStatusInput = z.output<typeof productStatusSchema>;

const priceOverrideSchema = z.object({
  currency: currencySchema,
  amount: z
    .number({ error: 'amount is required (integer in minor units, e.g. cents)' })
    .int({ error: 'amount must be an integer in minor units (never float)' })
    .min(0, { error: 'amount must be zero or greater' })
    .max(999_999_999, { error: 'amount is too large' }),
});

const productTranslationSchema = z.object({
  locale: localeSchema,
  name: z
    .string({ error: 'translation.name is required' })
    .trim()
    .min(1, { error: 'translation.name must not be empty' })
    .max(200, { error: 'translation.name must be at most 200 characters long' }),
  description: z
    .string({ error: 'translation.description is required' })
    .trim()
    .min(1, { error: 'translation.description must not be empty' })
    .max(5000, { error: 'translation.description must be at most 5000 characters long' }),
});

const adminImageSchema = z.object({
  url: imageUrlSchema,
  alt: z
    .string({ error: 'alt must be a string' })
    .trim()
    .max(200, { error: 'alt must be at most 200 characters long' })
    .optional(),
});

/**
 * Body for `POST /admin/products`. The base price (`priceAmount` +
 * `currency`) must use `BASE_CURRENCY` (see ADR 0007); every other
 * currency is a fixed override in `prices`. `translations` hold only
 * non-default locales — the base `name`/`description` columns hold the
 * `DEFAULT_LOCALE` content (see ADR 0008). `specs` is validated against
 * the Zod schema of the product category (unknown keys rejected).
 */
export const createProductSchema = z.object({
  sku: z
    .string({ error: 'sku is required' })
    .trim()
    .min(1, { error: 'sku must not be empty' })
    .max(100, { error: 'sku must be at most 100 characters long' }),
  name: z
    .string({ error: 'name is required' })
    .trim()
    .min(1, { error: 'name must not be empty' })
    .max(200, { error: 'name must be at most 200 characters long' }),
  slug: slugSchema,
  description: z
    .string({ error: 'description is required' })
    .trim()
    .min(1, { error: 'description must not be empty' })
    .max(5000, { error: 'description must be at most 5000 characters long' }),
  brandId: z.uuid({ error: 'brandId must be a valid UUID' }),
  categoryId: z.uuid({ error: 'categoryId must be a valid UUID' }),
  priceAmount: z
    .number({ error: 'priceAmount is required (integer in minor units, e.g. cents)' })
    .int({ error: 'priceAmount must be an integer in minor units (never float)' })
    .min(0, { error: 'priceAmount must be zero or greater' })
    .max(999_999_999, { error: 'priceAmount is too large' }),
  currency: currencySchema,
  status: productStatusSchema.default('DRAFT'),
  specs: z.record(z.string(), z.unknown()).default({}),
  prices: z.array(priceOverrideSchema).max(20, { error: 'at most 20 price overrides' }).default([]),
  translations: z
    .array(productTranslationSchema)
    .max(20, { error: 'at most 20 translations' })
    .default([]),
  images: z.array(adminImageSchema).max(10, { error: 'at most 10 images per product' }).default([]),
  initialStock: z
    .number({ error: 'initialStock must be an integer' })
    .int({ error: 'initialStock must be an integer' })
    .min(0, { error: 'initialStock must be zero or greater' })
    .max(1_000_000, { error: 'initialStock is too large' })
    .default(0),
});

export type CreateProductInput = z.output<typeof createProductSchema>;

/**
 * Body for `PATCH /admin/products/:id`. Every field is optional; omitted
 * fields are left untouched. `prices`/`translations` (when present)
 * replace the whole set — same replace semantics as images. `specs`
 * (when present) is validated against the effective category (the new one
 * when `categoryId` changes, else the current one).
 */
export const updateProductSchema = z.object({
  sku: createProductSchema.shape.sku.optional(),
  name: createProductSchema.shape.name.optional(),
  slug: slugSchema.optional(),
  description: createProductSchema.shape.description.optional(),
  brandId: createProductSchema.shape.brandId.optional(),
  categoryId: createProductSchema.shape.categoryId.optional(),
  priceAmount: createProductSchema.shape.priceAmount.optional(),
  currency: currencySchema.optional(),
  specs: z.record(z.string(), z.unknown()).optional(),
  prices: z.array(priceOverrideSchema).max(20, { error: 'at most 20 price overrides' }).optional(),
  translations: z
    .array(productTranslationSchema)
    .max(20, { error: 'at most 20 translations' })
    .optional(),
});

export type UpdateProductInput = z.output<typeof updateProductSchema>;

export const updateProductStatusSchema = z.object({
  status: productStatusSchema,
});

export type UpdateProductStatusInput = z.output<typeof updateProductStatusSchema>;

/**
 * Body for `PUT /admin/products/:id/images`. The list is the complete,
 * ordered set: it replaces the previous images transactionally (add,
 * remove, reorder and URL changes in one call). Empty array removes all
 * images. At most 10 entries, https URLs only.
 */
export const replaceProductImagesSchema = z.object({
  images: z.array(adminImageSchema).max(10, { error: 'at most 10 images per product' }),
});

export type ReplaceProductImagesInput = z.output<typeof replaceProductImagesSchema>;

/**
 * Stock filter for `GET /admin/products` (inventory screen): `out_of_stock`
 * is zero available units (`stock - reserved <= 0`), `low_stock` is at or
 * below `lowStockThreshold` (inclusive, so it contains `out_of_stock` —
 * same definition as the metrics overview attention counts and the
 * frontend `isLowStock` helper), and `reserved` is any held units
 * (`reserved > 0`). Every product owns an `inventory` row (created with
 * the product), so matching filters on that table.
 */
export const adminProductStockFilterSchema = z.enum(['out_of_stock', 'low_stock', 'reserved']);

export type AdminProductStockFilter = z.output<typeof adminProductStockFilterSchema>;

/** Query for `GET /admin/products`: every status is visible (no ACTIVE filter). */
export const adminProductListQuerySchema = z.object({
  status: productStatusSchema.optional(),
  category: z.string().trim().min(1).max(100).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  stock: adminProductStockFilterSchema.optional(),
  lowStockThreshold: z.coerce.number().int().min(1).max(1000).default(5),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AdminProductListQuery = z.output<typeof adminProductListQuerySchema>;

/**
 * Query for `GET /admin/products/metrics`. `low_stock` uses the same
 * threshold semantics as the list filter (inclusive of `out_of_stock`).
 */
export const adminProductMetricsQuerySchema = z.object({
  lowStockThreshold: z.coerce.number().int().min(1).max(1000).default(5),
});

export type AdminProductMetricsQuery = z.output<typeof adminProductMetricsQuerySchema>;

const categoryTranslationSchema = z.object({
  locale: localeSchema,
  name: z
    .string({ error: 'translation.name is required' })
    .trim()
    .min(1, { error: 'translation.name must not be empty' })
    .max(200, { error: 'translation.name must be at most 200 characters long' }),
});

const categoryImageAltSchema = z
  .string({ error: 'imageAlt must be a string' })
  .trim()
  .max(200, { error: 'imageAlt must be at most 200 characters long' });

/** Body for `POST /admin/categories`. */
export const createCategorySchema = z.object({
  name: z
    .string({ error: 'name is required' })
    .trim()
    .min(1, { error: 'name must not be empty' })
    .max(200, { error: 'name must be at most 200 characters long' }),
  slug: slugSchema,
  parentId: z.uuid({ error: 'parentId must be a valid UUID' }).optional(),
  /** Single cover image (same https rule as product images); omitted = no image. */
  imageUrl: imageUrlSchema.nullable().optional(),
  imageAlt: categoryImageAltSchema.nullable().optional(),
  /** Home "shop by category" visibility; defaults to true (same as the DB). */
  showInHome: z.boolean({ error: 'showInHome must be a boolean' }).default(true),
  translations: z
    .array(categoryTranslationSchema)
    .max(20, { error: 'at most 20 translations' })
    .default([]),
});

export type CreateCategoryInput = z.output<typeof createCategorySchema>;

/** Body for `PATCH /admin/categories/:id` (translations replace the whole set). */
export const updateCategorySchema = z.object({
  name: createCategorySchema.shape.name.optional(),
  slug: slugSchema.optional(),
  parentId: z.uuid({ error: 'parentId must be a valid UUID' }).nullable().optional(),
  /** `null`/empty clears the cover image; omitted leaves it untouched. */
  imageUrl: imageUrlSchema.nullable().optional(),
  imageAlt: categoryImageAltSchema.nullable().optional(),
  showInHome: z.boolean({ error: 'showInHome must be a boolean' }).optional(),
  translations: z
    .array(categoryTranslationSchema)
    .max(20, { error: 'at most 20 translations' })
    .optional(),
});

export type UpdateCategoryInput = z.output<typeof updateCategorySchema>;

/** Body for `POST /admin/brands`. */
export const createBrandSchema = z.object({
  name: z
    .string({ error: 'name is required' })
    .trim()
    .min(1, { error: 'name must not be empty' })
    .max(200, { error: 'name must be at most 200 characters long' }),
  slug: slugSchema,
});

export type CreateBrandInput = z.output<typeof createBrandSchema>;

/** Body for `PATCH /admin/brands/:id`. */
export const updateBrandSchema = z.object({
  name: createBrandSchema.shape.name.optional(),
  slug: slugSchema.optional(),
});

export type UpdateBrandInput = z.output<typeof updateBrandSchema>;

/**
 * Body for `PATCH /admin/inventory/:productId`. Adjusts the physical
 * `stock` by a signed `delta` (positive = restock, negative = correction)
 * with a mandatory human-readable motive. Every call appends exactly one
 * `InventoryMovement` row. `delta: 0` is rejected (no-op adjustments would
 * pollute the audit trail).
 */
export const adjustInventorySchema = z.object({
  delta: z
    .number({ error: 'delta is required (signed integer of units)' })
    .int({ error: 'delta must be an integer' })
    .min(-1_000_000, { error: 'delta is too small' })
    .max(1_000_000, { error: 'delta is too large' })
    .refine((value) => value !== 0, {
      error: 'delta must not be zero (no-op adjustments are rejected)',
    }),
  reason: z
    .string({ error: 'reason is required (human-readable motive for the audit trail)' })
    .trim()
    .min(1, { error: 'reason must not be empty' })
    .max(280, { error: 'reason must be at most 280 characters long' }),
});

export type AdjustInventoryInput = z.output<typeof adjustInventorySchema>;

export const orderStatusSchema = z.enum([
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
]);

export type OrderStatusInput = z.output<typeof orderStatusSchema>;

/**
 * Body for `PATCH /admin/orders/:id/status`. The target must be reachable
 * from the current status in one step of the machine in
 * `order-status.ts`. Transitions into `PAID` are rejected here: only the
 * Stripe webhook marks orders as paid (restriction 7b).
 */
export const updateOrderStatusSchema = z.object({
  status: orderStatusSchema,
});

export type UpdateOrderStatusInput = z.output<typeof updateOrderStatusSchema>;

/** Query for `GET /admin/orders`: optional status/date/user filters + pagination. */
export const adminOrderListQuerySchema = z.object({
  status: orderStatusSchema.optional(),
  userId: z.uuid({ error: 'userId must be a valid UUID' }).optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  /** Customer search: matches the buyer name or email (same rule as products `q`). */
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AdminOrderListQuery = z.output<typeof adminOrderListQuerySchema>;

/**
 * Query for `GET /admin/metrics/overview`: exact dashboard aggregation over
 * an optional UTC date range on `orders.createdAt`. `granularity` picks the
 * sales-bucket step (`hour` = 24 UTC hours of the `to` day, `day` = UTC
 * calendar days from `from` to `to`). Absent bounds default to the last 7
 * UTC days ending now. `lowStockThreshold` mirrors the frontend
 * `LOW_STOCK_THRESHOLD` default so both sides stay in sync by contract.
 */
export const metricsOverviewQuerySchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  granularity: z.enum(['hour', 'day']).default('day'),
  lowStockThreshold: z.coerce.number().int().min(1).max(1000).default(5),
});

export type MetricsOverviewQuery = z.output<typeof metricsOverviewQuerySchema>;
