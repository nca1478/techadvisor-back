import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One compatibility finding: rule id, severity, involved products, message. */
export class CompatibilityIssueDto {
  @ApiProperty({ example: 'cpu-socket', description: 'Rule that produced this finding.' })
  rule!: string;

  @ApiProperty({
    enum: ['error', 'warning'],
    example: 'error',
    description: 'Errors prove incompatibility; warnings signal uncertainty.',
  })
  severity!: 'error' | 'warning';

  @ApiProperty({
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    description: 'Ids of the products involved in this finding.',
  })
  productIds!: string[];

  @ApiProperty({
    example: 'cpu-socket.mismatch',
    description: 'Stable i18n key of the message (es + en available).',
  })
  messageKey!: string;

  @ApiProperty({
    example:
      'El procesador "Ryzen 5" usa socket AM5, pero la placa "PRO B660M" usa socket LGA1700.',
    description: 'Human-readable message in the requested locale.',
  })
  message!: string;
}

export class CompatibilityCheckRequestDto {
  @ApiProperty({
    example: ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    description: 'Product ids to check together (1..20 unique UUIDs).',
  })
  productIds!: string[];

  @ApiPropertyOptional({
    example: 'es',
    description: 'BCP 47 locale for issue messages; defaults server-side.',
  })
  locale?: string;
}

export class CompatibilityCheckResponseDto {
  @ApiProperty({
    example: false,
    description:
      'True only when every rule passed with complete data. Any warning (missing data) makes it false: without enough evidence compatibility is never claimed.',
  })
  compatible!: boolean;

  @ApiProperty({ type: [CompatibilityIssueDto] })
  issues!: CompatibilityIssueDto[];
}
