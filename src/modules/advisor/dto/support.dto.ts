import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductQaCitationDto } from './advisor.dto.js';

export class SupportRequestDto {
  @ApiProperty({
    example: '¿Cuánto dura la garantía de un portátil?',
    description: 'Question about warranty, shipping, returns, payments or privacy (1..1000 chars).',
  })
  question!: string;

  @ApiPropertyOptional({
    example: 'order-id',
    description:
      'Owned order to ground the answer in (status/total from SQL). Requires authentication; other users’ orders 404.',
  })
  orderId?: string;

  @ApiPropertyOptional({
    example: 'es',
    description: 'BCP 47 answer locale; defaults server-side.',
  })
  locale?: string;
}

export class SupportResponseDto {
  @ApiProperty({
    example: 'Los portátiles tienen 2 años de garantía [1].',
    description: 'Assistant answer in the request locale, with [n] citation markers.',
  })
  answer!: string;

  @ApiProperty({ type: [ProductQaCitationDto] })
  citations!: ProductQaCitationDto[];

  @ApiProperty({
    example: false,
    description:
      'True when no sufficient evidence existed: the LLM was not called and the query was recorded for review.',
  })
  abstained!: boolean;
}
