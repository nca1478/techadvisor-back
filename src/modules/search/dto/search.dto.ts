import { ApiProperty } from '@nestjs/swagger';
import { ProductListItemDto } from '../../catalog/dto/catalog.dto.js';

/**
 * One catalog hit: the product (hydrated from SQL — price, availability and
 * primary image never come from chunks) plus the retrieval evidence.
 */
export class SearchResultDto {
  @ApiProperty({ type: ProductListItemDto, description: 'Product hydrated from SQL.' })
  product!: ProductListItemDto;

  @ApiProperty({
    example: 0.032,
    description: 'Best fused retrieval score among the product chunks.',
  })
  score!: number;

  @ApiProperty({
    example: 'Ligero y cómodo para sesiones largas…',
    description: 'Evidence fragment from the best matching chunk (truncated).',
  })
  snippet!: string;
}

export class SearchResponseDto {
  @ApiProperty({ example: 'audífonos livianos para usar muchas horas' })
  query!: string;

  @ApiProperty({
    example: false,
    description: 'True when embeddings failed and results are full-text only.',
  })
  degraded!: boolean;

  @ApiProperty({ example: 'es', description: 'Resolved locale of the returned texts.' })
  locale!: string;

  @ApiProperty({ example: 'USD', description: 'Currency of every product price.' })
  currency!: string;

  @ApiProperty({ type: [SearchResultDto] })
  results!: SearchResultDto[];
}
