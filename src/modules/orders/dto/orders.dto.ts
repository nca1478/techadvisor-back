import { ApiProperty } from '@nestjs/swagger';

/** Validated international shipping address snapshot stored on the order. */
export class ShippingAddressDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  fullName!: string;

  @ApiProperty({ example: 'Calle Mayor 1, 2º B' })
  line1!: string;

  @ApiProperty({ example: 'Edificio Norte', required: false })
  line2?: string;

  @ApiProperty({ example: 'Madrid' })
  city!: string;

  @ApiProperty({ example: 'Madrid', required: false })
  region?: string;

  @ApiProperty({ example: '28001', required: false })
  postalCode?: string;

  @ApiProperty({ example: 'ES', description: 'ISO 3166-1 alpha-2 country code.' })
  country!: string;

  @ApiProperty({ example: '+34 600 123 456', required: false })
  phone?: string;
}

/** Body for POST /orders: the user cart is implicit, money comes from the DB. */
export class CreateOrderDto {
  @ApiProperty({ type: ShippingAddressDto })
  shipping!: ShippingAddressDto;
}

export class OrderItemDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  productId!: string;

  @ApiProperty({ example: 'Laptop 13 (Ultra 7, 16 GB, 512 GB)' })
  name!: string;

  @ApiProperty({ example: 'laptop-13-ultra-7-16-512' })
  slug!: string;

  @ApiProperty({ example: 2 })
  qty!: number;

  @ApiProperty({
    example: 129900,
    description: 'Frozen unit price in minor units, in the order currency.',
  })
  unitPriceAmount!: number;

  @ApiProperty({ example: 259800, description: 'unitPriceAmount * qty, in minor units.' })
  lineTotalAmount!: number;
}

export class OrderResponseDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({
    example: 'PENDING_PAYMENT',
    enum: ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
  })
  status!: string;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 code of all money fields.' })
  currency!: string;

  @ApiProperty({ example: 259800, description: 'Frozen total in minor units.' })
  totalAmount!: number;

  @ApiProperty({ example: 3, description: 'Sum of item quantities.' })
  itemCount!: number;

  @ApiProperty({ type: ShippingAddressDto })
  shipping!: ShippingAddressDto;

  @ApiProperty({ type: [OrderItemDto] })
  items!: OrderItemDto[];

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  updatedAt!: Date;
}
