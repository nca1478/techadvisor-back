import { ApiProperty } from '@nestjs/swagger';

/** Client-provided line write: product + quantity only (never money). */
export class AddCartItemDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  productId!: string;

  @ApiProperty({ example: 1, minimum: 1, maximum: 999 })
  qty!: number;
}

export class UpdateCartItemDto {
  @ApiProperty({ example: 2, minimum: 1, maximum: 999 })
  qty!: number;
}

/** One cart line, fully priced server-side from the database. */
export class CartItemDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  productId!: string;

  @ApiProperty({ example: 'Laptop 13 (Ultra 7, 16 GB, 512 GB)' })
  name!: string;

  @ApiProperty({ example: 'laptop-13-ultra-7-16-512' })
  slug!: string;

  @ApiProperty({
    example: 'https://cdn.example.com/p/laptop-13-front.jpg',
    nullable: true,
    description: 'Primary product image (lowest position), if any.',
  })
  imageUrl!: string | null;

  @ApiProperty({ example: 129900, description: 'Unit price in minor units, in `currency`.' })
  unitPriceAmount!: number;

  @ApiProperty({ example: 2 })
  qty!: number;

  @ApiProperty({ example: 259800, description: 'unitPriceAmount * qty, in minor units.' })
  lineTotalAmount!: number;

  @ApiProperty({ example: true, description: 'Whether at least one unit is available.' })
  inStock!: boolean;

  @ApiProperty({
    example: true,
    description: 'Whether the line quantity fits the available stock.',
  })
  sufficientStock!: boolean;

  @ApiProperty({
    example: 7,
    description: 'Available units, capped at 10 so the API never leaks exact stock.',
  })
  availableQuantity!: number;
}

export class CartResponseDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'USD', description: 'Currency of all money fields in this response.' })
  currency!: string;

  @ApiProperty({ example: 'en', description: 'Resolved locale of the returned product names.' })
  locale!: string;

  @ApiProperty({ type: [CartItemDto] })
  items!: CartItemDto[];

  @ApiProperty({ example: 259800, description: 'Sum of line totals, in minor units.' })
  totalAmount!: number;

  @ApiProperty({ example: 3, description: 'Sum of line quantities.' })
  itemCount!: number;
}
