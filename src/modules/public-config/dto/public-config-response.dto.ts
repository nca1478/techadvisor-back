import { ApiProperty } from '@nestjs/swagger';

export class PublicConfigResponseDto {
  @ApiProperty({ example: 'USD', description: 'Base currency (ISO 4217).' })
  baseCurrency!: string;

  @ApiProperty({
    example: ['USD', 'EUR'],
    type: [String],
    description: 'Currencies supported by the API (ISO 4217 codes).',
  })
  supportedCurrencies!: string[];

  @ApiProperty({ example: 'en', description: 'Default locale (BCP 47).' })
  defaultLocale!: string;

  @ApiProperty({
    example: ['en', 'es'],
    type: [String],
    description: 'Locales supported by the API (BCP 47).',
  })
  supportedLocales!: string[];
}
