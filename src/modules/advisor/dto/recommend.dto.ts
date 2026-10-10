import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ProductQaCitationDto } from './advisor.dto.js';

/**
 * Body for the recommendation branch of `POST /advisor/sessions/:id/messages`
 * (see ADR 0032): sent WITHOUT `role`. The legacy shape (`role` + `content`)
 * keeps its raw-append behavior.
 */
export class RecommendRequestDto {
  @ApiProperty({
    example: 'Busco un portátil para estudiar ingeniería, máx. 800 USD.',
    description: 'User message starting (or continuing) the buying conversation.',
  })
  content!: string;

  @ApiPropertyOptional({
    example: 'es',
    description: 'BCP 47 answer locale; defaults server-side.',
  })
  locale?: string;

  @ApiPropertyOptional({
    example: 'USD',
    description: 'ISO 4217 session currency for budget and prices; defaults server-side.',
  })
  currency?: string;
}

/**
 * One recommended product card. Display data (name, price, stock, image)
 * always comes from SQL — never from the LLM text.
 */
export class RecommendProductDto {
  @ApiProperty({
    example: 'product-id',
    description: 'Recommended product id (from the SQL closed set).',
  })
  productId!: string;

  @ApiProperty({ example: 'Auriculares X200', description: 'Product name from the database.' })
  name!: string;

  @ApiProperty({ example: 'auriculares-x200', description: 'Product slug for links.' })
  slug!: string;

  @ApiProperty({ example: 10000, description: 'Effective price in minor units, session currency.' })
  priceAmount!: number;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 code of priceAmount.' })
  currency!: string;

  @ApiProperty({ example: true, description: 'Whether the product is currently in stock.' })
  inStock!: boolean;

  @ApiProperty({ example: 5, description: 'Visible available quantity (capped).' })
  availableQuantity!: number;

  @ApiProperty({
    example: 'https://example.com/img.jpg',
    description: 'Primary product image URL, when present.',
    nullable: true,
  })
  imageUrl!: string | null;

  @ApiProperty({
    example: '16 GB de RAM y SSD NVMe, ideal para tus clases [1].',
    description: 'Why it fits, drafted by the LLM (or a deterministic spec summary as fallback).',
  })
  reason!: string;

  @ApiProperty({
    description: 'Validated [n] citations resolved against the delivered evidence.',
  })
  citations!: ProductQaCitationDto[];
}

export class RecommendResponseDto {
  @ApiProperty({
    example: 'Estas opciones encajan con tu presupuesto [1].',
    description:
      'Assistant message: recommendation text, clarification question, or deterministic relax hint.',
  })
  message!: string;

  @ApiProperty({ type: [RecommendProductDto] })
  products!: RecommendProductDto[];

  @ApiPropertyOptional({
    example: '¿Cuál es tu presupuesto máximo (y en qué moneda)?',
    description: 'Present only when the advisor needs one clarification before recommending.',
  })
  clarifyingQuestion?: string;
}
