import { ApiProperty } from '@nestjs/swagger';
import type { SpecFieldDef } from '../specs/index.js';

/** Whitelisted brand shape for catalog responses (no internal fields). */
export class CatalogBrandDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'Framework' })
  name!: string;

  @ApiProperty({ example: 'framework' })
  slug!: string;
}

export class SpecFieldDto implements SpecFieldDef {
  @ApiProperty({ example: 'ram_gb' })
  key!: string;

  @ApiProperty({ example: 'RAM' })
  label!: string;

  @ApiProperty({ enum: ['string', 'integer', 'number', 'boolean', 'enum'] })
  type!: 'string' | 'integer' | 'number' | 'boolean' | 'enum';

  @ApiProperty({ example: 'GB', required: false })
  unit?: string;

  @ApiProperty({ example: ['DDR4', 'DDR5'], required: false })
  options?: string[];
}

/** Whitelisted category shape, including the specs schema for the frontend. */
export class CatalogCategoryDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'Laptops' })
  name!: string;

  @ApiProperty({ example: 'laptops' })
  slug!: string;

  @ApiProperty({ example: null, nullable: true })
  parentSlug!: string | null;

  @ApiProperty({ type: [SpecFieldDto], description: 'Specs field definitions for this category.' })
  specsSchema!: SpecFieldDto[];

  @ApiProperty({ example: 'en', description: 'Resolved locale of the returned texts.' })
  locale!: string;
}

export class ProductImageDto {
  @ApiProperty({ example: 'https://cdn.example.com/p/laptop-13-front.jpg' })
  url!: string;

  @ApiProperty({ example: 'Laptop 13 front view', nullable: true })
  alt!: string | null;

  @ApiProperty({ example: 0 })
  position!: number;
}

/** Single item of the paginated product list (primary image only). */
export class ProductListItemDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'FW13-ULT7-16-512' })
  sku!: string;

  @ApiProperty({ example: 'Laptop 13 (Ultra 7, 16 GB, 512 GB)' })
  name!: string;

  @ApiProperty({ example: 'laptop-13-ultra-7-16-512' })
  slug!: string;

  @ApiProperty({ example: 'A portable workstation…', description: 'Localized description.' })
  description!: string;

  @ApiProperty({ type: CatalogBrandDto })
  brand!: CatalogBrandDto;

  @ApiProperty({ type: CatalogCategoryDto })
  category!: CatalogCategoryDto;

  @ApiProperty({ example: 129900, description: 'Price in minor units, in `currency`.' })
  priceAmount!: number;

  @ApiProperty({
    example: 'USD',
    description: 'Actual currency of `priceAmount` (may be the base currency fallback).',
  })
  currency!: string;

  @ApiProperty({ example: { ram_gb: 16, cpu: 'Intel Core Ultra 7 155H' } })
  specs!: Record<string, unknown>;

  @ApiProperty({ example: 'https://cdn.example.com/p/laptop-13-front.jpg', nullable: true })
  imageUrl!: string | null;

  @ApiProperty({
    example: 'Laptop 13 front view',
    nullable: true,
    description: 'Image alt when set; otherwise clients fall back to the product name.',
  })
  imageAlt!: string | null;

  @ApiProperty({ example: 'en' })
  locale!: string;

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  createdAt!: Date;
}

/** Full product detail (all images ordered by position). */
export class ProductDetailDto {
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

  @ApiProperty({ type: CatalogBrandDto })
  brand!: CatalogBrandDto;

  @ApiProperty({ type: CatalogCategoryDto })
  category!: CatalogCategoryDto;

  @ApiProperty({ example: 129900, description: 'Price in minor units, in `currency`.' })
  priceAmount!: number;

  @ApiProperty({
    example: 'USD',
    description: 'Actual currency of `priceAmount` (may be the base currency fallback).',
  })
  currency!: string;

  @ApiProperty({ example: { ram_gb: 16, cpu: 'Intel Core Ultra 7 155H' } })
  specs!: Record<string, unknown>;

  @ApiProperty({
    type: [ProductImageDto],
    description: 'All images ordered by position ascending.',
  })
  images!: ProductImageDto[];

  @ApiProperty({ example: 'en' })
  locale!: string;

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  createdAt!: Date;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;

  @ApiProperty({ example: true })
  hasNext!: boolean;

  @ApiProperty({ example: false })
  hasPrev!: boolean;
}

export class PaginatedProductsDto {
  @ApiProperty({ type: [ProductListItemDto] })
  data!: ProductListItemDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}
