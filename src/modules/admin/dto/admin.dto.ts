import { ApiProperty } from '@nestjs/swagger';

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

  @ApiProperty({ example: 'PAID' })
  status!: string;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ example: 259800 })
  totalAmount!: number;

  @ApiProperty({ type: [AdminOrderItemDto] })
  items!: AdminOrderItemDto[];

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
