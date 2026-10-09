import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One validated citation: the `[n]` marker in `answer` resolved against the
 * evidence chunks delivered to the LLM. Markers pointing outside `1..N` are
 * discarded by the service and never appear here (see ADR 0025).
 */
export class ProductQaCitationDto {
  @ApiProperty({
    example: 1,
    description: '1-based number of the cited chunk ([n] in the answer).',
  })
  n!: number;

  @ApiProperty({ example: 'doc-id', description: 'Source document id.' })
  documentId!: string;

  @ApiProperty({ example: 'chunk-id', description: 'Source chunk id.' })
  chunkId!: string;

  @ApiProperty({ example: 'X200 manual', description: 'Source document title.' })
  title!: string;

  @ApiProperty({
    example: 'La batería dura hasta 10 horas…',
    description: 'Evidence fragment from the cited chunk (truncated).',
  })
  snippet!: string;
}

export class ProductQaRequestDto {
  @ApiProperty({ example: 'product-id', description: 'Asked-about product id (must be ACTIVE).' })
  productId!: string;

  @ApiProperty({ example: '¿Cuánto dura la batería?', description: 'Question (1..1000 chars).' })
  question!: string;

  @ApiPropertyOptional({
    example: 'es',
    description: 'BCP 47 answer locale; defaults server-side.',
  })
  locale?: string;

  @ApiPropertyOptional({
    example: 'session-id',
    description:
      'Owned chat session to record this turn in (question + answer with citations); cross-user ids 404.',
  })
  sessionId?: string;
}

export class AdvisorFeedbackRequestDto {
  @ApiPropertyOptional({
    example: 'product-id',
    description: 'Asked-about product id, when the vote comes from a product page.',
  })
  productId?: string;

  @ApiProperty({ example: '¿Cuánto dura la batería?', description: 'Question (1..1000 chars).' })
  question!: string;

  @ApiProperty({
    example: 'La batería dura hasta 10 horas [1].',
    description: 'Answer the vote refers to (1..20000 chars).',
  })
  answer!: string;

  @ApiProperty({ example: false, description: 'Whether the voted answer was an abstention.' })
  abstained!: boolean;

  @ApiProperty({ enum: ['up', 'down'], example: 'up', description: 'Vote direction.' })
  value!: 'up' | 'down';
}

export class AdvisorFeedbackResponseDto {
  @ApiProperty({ example: true, description: 'True when the vote was recorded.' })
  ok!: boolean;
}

export class ProductQaResponseDto {
  @ApiProperty({
    example: 'La batería dura hasta 10 horas [1].',
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
