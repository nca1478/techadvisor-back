import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CompatibilityIssueDto } from '../../compatibility/dto/compatibility.dto.js';
import { ProductQaCitationDto } from './advisor.dto.js';

export class CompareRequestDto {
  @ApiProperty({
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6', '6ba7b811-9dad-11d1-80b4-00c04fd430c8'],
    description: 'Ids of the 2..3 ACTIVE products to compare (unique UUIDs).',
  })
  productIds!: string[];

  @ApiPropertyOptional({
    example: 'gaming en 1080p',
    description: 'Use case the summary focuses on (1..500 chars).',
  })
  useCase?: string;

  @ApiPropertyOptional({
    example: 'es',
    description: 'BCP 47 summary locale; defaults server-side.',
  })
  locale?: string;
}

/** One compared product: SQL display data (never LLM-generated). */
export class CompareProductDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  productId!: string;

  @ApiProperty({ example: 'Auriculares X200' })
  name!: string;

  @ApiProperty({ example: 'auriculares-x200' })
  slug!: string;

  @ApiProperty({ example: 10000, description: 'Base price in minor units.' })
  priceAmount!: number;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency of priceAmount.' })
  currency!: string;

  @ApiProperty({ example: { ram_gb: 16 }, description: 'Structured specs from SQL.' })
  specs!: Record<string, unknown>;
}

/** One table row: aligned values in product (column) order. */
export class CompareTableRowDto {
  @ApiProperty({
    example: 'ram_gb',
    description: "Spec key, or 'price_amount' for the SQL price row.",
  })
  key!: string;

  @ApiProperty({
    example: [16, 32],
    description: 'Raw values per product column (null when the product lacks the spec).',
  })
  values!: unknown[];

  @ApiProperty({
    example: [1],
    description: 'Column indexes holding the best value (empty when not objective).',
  })
  best!: number[];

  @ApiProperty({
    example: 'higher',
    description: "Objective direction ('higher' | 'lower'), or null for text/enum rows.",
    nullable: true,
  })
  direction!: 'higher' | 'lower' | null;
}

/** Deterministic compatibility verdict (decided by the rule engine, not the LLM). */
export class CompareCompatibilityDto {
  @ApiProperty({ example: false })
  compatible!: boolean;

  @ApiProperty({ type: [CompatibilityIssueDto] })
  issues!: CompatibilityIssueDto[];
}

export class CompareResponseDto {
  @ApiProperty({ type: [CompareProductDto] })
  products!: CompareProductDto[];

  @ApiProperty({ type: [CompareTableRowDto] })
  table!: CompareTableRowDto[];

  @ApiProperty({ type: CompareCompatibilityDto })
  compatibility!: CompareCompatibilityDto;

  @ApiProperty({
    example: 'El modelo B ofrece más RAM [1] por un precio menor.',
    description: 'LLM summary over the table and evidence, with [n] citation markers.',
  })
  summary!: string;

  @ApiProperty({ type: [ProductQaCitationDto] })
  citations!: ProductQaCitationDto[];
}
