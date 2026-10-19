import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { SearchResponseDto } from './dto/search.dto.js';
import { SearchService } from './search.service.js';
import { searchQuerySchema, type SearchQuery } from './search-query.schema.js';

/**
 * Public natural-language catalog search (no auth, no LLM).
 *
 * Rate-limited per IP by the `search` throttler (`SEARCH_RATE_LIMIT_*`; the
 * `auth` throttler is skipped here). `q` is capped at 200 chars by the query
 * schema. Price, availability and images come from SQL — never from chunks.
 */
@ApiTags('search')
@Controller('search')
@UseGuards(ThrottlerGuard)
@SkipThrottle({ auth: true })
@ApiUniformErrorResponses(ErrorResponseDto)
@ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'Rate limit exceeded.' })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Product search: natural-language over the RAG corpus, or filter-only browse',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Natural-language query (0..200 chars). Empty browses by filters.',
  })
  @ApiQuery({ name: 'category', required: false, description: 'Category slug filter.' })
  @ApiQuery({ name: 'brand', required: false, description: 'Brand slug filter.' })
  @ApiQuery({
    name: 'sort',
    required: false,
    description:
      'Explicit ordering (price_asc, price_desc, name_asc, name_desc, newest). Default: relevance.',
  })
  @ApiQuery({
    name: 'inStock',
    required: false,
    description: 'When 1/true, only products in stock.',
  })
  @ApiQuery({
    name: 'maxPrice',
    required: false,
    description: 'Max price in minor units, in `currency`.',
  })
  @ApiQuery({
    name: 'currency',
    required: false,
    description: 'ISO 4217 code; defaults to base currency.',
  })
  @ApiQuery({
    name: 'locale',
    required: false,
    description: 'BCP 47 locale; falls back to default.',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Max products (1..24, default 12).' })
  @ApiOkResponse({ type: SearchResponseDto })
  searchProducts(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
  ): Promise<SearchResponseDto> {
    return this.search.search(query);
  }
}
