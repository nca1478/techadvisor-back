import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { PublicConfigResponseDto } from './dto/public-config-response.dto.js';

/**
 * Public, unauthenticated configuration the frontend reads at runtime instead
 * of duplicating it (`// mantener en sync con backend` is avoided by design:
 * the frontend fetches this endpoint).
 */
@ApiTags('config')
@Controller('config')
@ApiUniformErrorResponses(ErrorResponseDto)
export class PublicConfigController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('public')
  @ApiOperation({ summary: 'Public runtime configuration for clients' })
  @ApiOkResponse({ type: PublicConfigResponseDto })
  getPublicConfig(): PublicConfigResponseDto {
    return {
      baseCurrency: this.config.BASE_CURRENCY,
      supportedCurrencies: this.config.SUPPORTED_CURRENCIES,
      defaultLocale: this.config.DEFAULT_LOCALE,
      supportedLocales: this.config.SUPPORTED_LOCALES,
    };
  }
}
