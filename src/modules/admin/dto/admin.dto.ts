import { ApiProperty } from '@nestjs/swagger';
import { OrderStatusHistoryDto, ShippingAddressDto } from '../../orders/dto/orders.dto.js';

/** Fixed per-currency price row (see ADR 0007). */
export class AdminPriceDto {
  @ApiProperty({ example: 'EUR' })
  currency!: string;

  @ApiProperty({ example: 119900 })
  amount!: number;
}

/** Non-default-locale product text (base columns hold DEFAULT_LOCALE). */
export class AdminProductTranslationDto {
  @ApiProperty({ example: 'es' })
  locale!: string;

  @ApiProperty({ example: 'Portátil 13' })
  name!: string;

  @ApiProperty({ example: 'Un portátil ligero…' })
  description!: string;
}

export class AdminProductImageDto {
  @ApiProperty({ example: 'https://cdn.example.com/p/laptop-13-front.jpg' })
  url!: string;

  @ApiProperty({ example: 'Front view', nullable: true })
  alt!: string | null;

  @ApiProperty({ example: 0 })
  position!: number;
}

/** Full admin view of a product: every status, every price, every locale. */
export class AdminProductDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'FW13-ULT7-16-512' })
  sku!: string;

  @ApiProperty({ example: 'Laptop 13 (Ultra 7, 16 GB, 512 GB)' })
  name!: string;

  @ApiProperty({ example: 'laptop-13-ultra-7-16-512' })
  slug!: string;

  @ApiProperty({ example: 'A portable workstation…' })
  description!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  brandId!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  categoryId!: string;

  @ApiProperty({ example: 129900 })
  priceAmount!: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ example: 'ACTIVE', enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'] })
  status!: string;

  @ApiProperty({ example: { ram_gb: 16 } })
  specs!: Record<string, unknown>;

  @ApiProperty({ type: [AdminPriceDto] })
  prices!: AdminPriceDto[];

  @ApiProperty({ type: [AdminProductTranslationDto] })
  translations!: AdminProductTranslationDto[];

  @ApiProperty({ type: [AdminProductImageDto] })
  images!: AdminProductImageDto[];

  @ApiProperty({ example: 10, description: 'Physical stock on hand (exact, admin-only).' })
  stock!: number;

  @ApiProperty({ example: 2, description: 'Units held by open orders/carts.' })
  reserved!: number;

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  updatedAt!: Date;
}

export class AdminProductListDto {
  @ApiProperty({ type: [AdminProductDto] })
  data!: AdminProductDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

/**
 * Catalog counters for the products back-office header (see ADR 0055):
 * totals by status plus stock health over `inventory` (`stock - reserved`,
 * same definition as the list filters and the overview attention counts).
 */
export class AdminProductMetricsDto {
  @ApiProperty({ example: 248, description: 'Products in every status.' })
  total!: number;

  @ApiProperty({ example: 211, description: 'Products with status ACTIVE.' })
  active!: number;

  @ApiProperty({
    example: 23,
    description: 'Available units at or below the threshold (includes out of stock).',
  })
  lowStock!: number;

  @ApiProperty({ example: 14, description: 'Zero available units.' })
  outOfStock!: number;

  @ApiProperty({ example: 230, description: 'More than zero available units.' })
  inStock!: number;

  @ApiProperty({ example: 7, description: 'Products with held units (reserved > 0).' })
  reserved!: number;

  @ApiProperty({ example: 5, description: 'Threshold applied to lowStock.' })
  lowStockThreshold!: number;
}

export class AdminCategoryTranslationDto {
  @ApiProperty({ example: 'es' })
  locale!: string;

  @ApiProperty({ example: 'Portátiles' })
  name!: string;
}

export class AdminCategoryDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'Laptops' })
  name!: string;

  @ApiProperty({ example: 'laptops' })
  slug!: string;

  @ApiProperty({ example: null, nullable: true })
  parentId!: string | null;

  @ApiProperty({
    example:
      'https://images.unsplash.com/photo-1496181133206-80ce9b88a853?q=80&w=800&auto=format&fit=crop',
    nullable: true,
    description: 'Single cover image (home "shop by category" card background).',
  })
  imageUrl!: string | null;

  @ApiProperty({
    example: 'Laptops',
    nullable: true,
    description: 'Cover image alt when set; otherwise clients fall back to the category name.',
  })
  imageAlt!: string | null;

  @ApiProperty({ example: true, description: 'Whether the category shows in the home section.' })
  showInHome!: boolean;

  @ApiProperty({ type: [AdminCategoryTranslationDto] })
  translations!: AdminCategoryTranslationDto[];
}

export class AdminBrandDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'Framework' })
  name!: string;

  @ApiProperty({ example: 'framework' })
  slug!: string;
}

/** Result of a stock adjustment: exact levels plus the audit row id. */
export class AdminInventoryDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  productId!: string;

  @ApiProperty({ example: 12 })
  stock!: number;

  @ApiProperty({ example: 2 })
  reserved!: number;

  @ApiProperty({ example: 10 })
  available!: number;

  @ApiProperty({
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description: 'Id of the appended InventoryMovement row.',
  })
  movementId!: string;
}

export class AdminInventoryMovementDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  productId!: string;

  @ApiProperty({ example: 5, description: 'Signed units applied to stock.' })
  delta!: number;

  @ApiProperty({ example: 'Restock from supplier #42' })
  reason!: string;

  @ApiProperty({ example: 15, description: 'Physical stock after applying delta.' })
  stockAfter!: number;

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  createdAt!: Date;
}

export class AdminOrderItemDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  productId!: string;

  @ApiProperty({ example: 'Laptop 13' })
  name!: string;

  @ApiProperty({ example: 'laptop-13' })
  slug!: string;

  @ApiProperty({ example: 2 })
  qty!: number;

  @ApiProperty({ example: 129900 })
  unitPriceAmount!: number;

  @ApiProperty({ example: 259800 })
  lineTotalAmount!: number;
}

/** Admin view of an order: any user, frozen prices preserved after archival. */
export class AdminOrderDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  userId!: string;

  // Explicit `type` so OpenAPI emits a nullable string (without it the
  // union's design:type degrades to `object` and clients see `Record`).
  @ApiProperty({ example: 'Ada Lovelace', nullable: true, type: String })
  userName!: string | null;

  @ApiProperty({ example: 'ada@example.com' })
  userEmail!: string;

  @ApiProperty({ example: 'PAID' })
  status!: string;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ example: 259800 })
  totalAmount!: number;

  @ApiProperty({ type: [AdminOrderItemDto] })
  items!: AdminOrderItemDto[];

  @ApiProperty({ type: ShippingAddressDto })
  shipping!: ShippingAddressDto;

  @ApiProperty({
    type: [OrderStatusHistoryDto],
    description: 'Recorded status changes, oldest first. Empty for pre-history orders.',
  })
  statusHistory!: OrderStatusHistoryDto[];

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  updatedAt!: Date;
}

export class AdminOrderListDto {
  @ApiProperty({ type: [AdminOrderDto] })
  data!: AdminOrderDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

/** Orders in the overview range grouped by status (sorted by status). */
export class AdminMetricsStatusCountDto {
  @ApiProperty({ example: 'PAID' })
  status!: string;

  @ApiProperty({ example: 12 })
  count!: number;
}

/** Collected revenue in one currency (sorted by amount, descending). */
export class AdminMetricsRevenueDto {
  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ example: 259800, description: 'Sum in minor units (never float).' })
  amount!: number;

  @ApiProperty({ example: 12, description: 'Collected orders counted in this currency.' })
  count!: number;
}

/** One sales bucket: UTC step start (ISO) plus collected minor-units amount. */
export class AdminMetricsBucketDto {
  @ApiProperty({ example: '2026-10-07T00:00:00.000Z' })
  key!: string;

  @ApiProperty({ example: 45000 })
  amount!: number;
}

/** Point-in-time operational backlog (never range-scoped). */
export class AdminMetricsAttentionDto {
  @ApiProperty({ example: 3, description: 'Products with zero available units.' })
  outOfStock!: number;

  @ApiProperty({ example: 5, description: 'Products at or below the low-stock threshold.' })
  lowStock!: number;

  @ApiProperty({ example: 2, description: 'Reviews awaiting moderation.' })
  pendingReviews!: number;

  @ApiProperty({ example: 1, description: 'Live (non-deleted) documents in FAILED.' })
  failedDocs!: number;

  @ApiProperty({ example: 4, description: 'Unanswered queries in NEW or IN_REVIEW.' })
  openUnanswered!: number;
}

/** Exact dashboard aggregation for `GET /admin/metrics/overview` (see ADR 0043). */
export class AdminMetricsOverviewDto {
  @ApiProperty({ example: '2026-10-07T00:00:00.000Z', nullable: true })
  from!: string | null;

  @ApiProperty({ example: '2026-10-13T15:30:00.000Z', nullable: true })
  to!: string | null;

  @ApiProperty({ example: 'day', enum: ['hour', 'day'] })
  granularity!: string;

  @ApiProperty({ example: 42, description: 'Orders created in range (exact).' })
  ordersTotal!: number;

  @ApiProperty({ type: [AdminMetricsStatusCountDto] })
  byStatus!: AdminMetricsStatusCountDto[];

  @ApiProperty({ type: [AdminMetricsRevenueDto] })
  revenue!: AdminMetricsRevenueDto[];

  @ApiProperty({
    example: 'USD',
    nullable: true,
    description: 'Mode currency of collected orders; null when none.',
  })
  bucketCurrency!: string | null;

  @ApiProperty({ type: [AdminMetricsBucketDto] })
  buckets!: AdminMetricsBucketDto[];

  @ApiProperty({ type: AdminMetricsAttentionDto })
  attention!: AdminMetricsAttentionDto;
}
