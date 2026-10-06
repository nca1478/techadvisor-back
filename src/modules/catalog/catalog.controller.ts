import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CatalogService } from './catalog.service.js';
import {
  catalogQuerySchema,
  localeCurrencySchema,
  type CatalogQuery,
  type LocaleCurrencyQuery,
} from './catalog-query.schema.js';
import {
  CatalogBrandDto,
  CatalogCategoryDto,
  PaginatedProductsDto,
  ProductDetailDto,
} from './dto/catalog.dto.js';

/**
 * Public read-only catalog (no auth). Only `ACTIVE` products are ever
 * returned. `locale` falls back to the default locale, `currency` defaults
 * to the base currency and must be supported (else 400).
 */
@ApiTags('catalog')
@Controller('catalog')
@ApiUniformErrorResponses(ErrorResponseDto)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  @ApiOperation({ summary: 'List active products with filters, sorting and pagination' })
  @ApiQuery({ name: 'category', required: false, description: 'Category slug.' })
  @ApiQuery({ name: 'brand', required: false, description: 'Brand slug.' })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Free text matched against the product name.',
  })
  @ApiQuery({
    name: 'minPrice',
    required: false,
    description: 'Min price in minor units, in `currency`.',
  })
  @ApiQuery({
    name: 'maxPrice',
    required: false,
    description: 'Max price in minor units, in `currency`.',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: ['price_asc', 'price_desc', 'name_asc', 'name_desc', 'newest'],
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (1-based).' })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page (1..100).' })
  @ApiQuery({
    name: 'locale',
    required: false,
    description: 'BCP 47 locale; falls back to default.',
  })
  @ApiQuery({
    name: 'currency',
    required: false,
    description: 'ISO 4217 code; defaults to base currency.',
  })
  @ApiOkResponse({ type: PaginatedProductsDto })
  listProducts(
    @Query(new ZodValidationPipe(catalogQuerySchema)) query: CatalogQuery,
  ): Promise<PaginatedProductsDto> {
    return this.catalog.listProducts(query);
  }

  @Get('products/:slug')
  @ApiOperation({ summary: 'Product detail by slug (active products only)' })
  @ApiParam({ name: 'slug', description: 'Product slug.' })
  @ApiOkResponse({ type: ProductDetailDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Unknown slug, or not ACTIVE.' })
  productDetail(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(localeCurrencySchema)) query: LocaleCurrencyQuery,
  ): Promise<ProductDetailDto> {
    return this.catalog.getProductBySlug(slug, query.locale, query.currency);
  }

  @Get('categories')
  @ApiOperation({ summary: 'List categories with their specs schemas' })
  @ApiQuery({ name: 'locale', required: false })
  @ApiOkResponse({ type: [CatalogCategoryDto] })
  listCategories(
    @Query(new ZodValidationPipe(localeCurrencySchema)) query: LocaleCurrencyQuery,
  ): Promise<CatalogCategoryDto[]> {
    return this.catalog.listCategories(query.locale);
  }

  @Get('categories/:slug')
  @ApiOperation({ summary: 'Category detail with its specs schema for dynamic forms' })
  @ApiParam({ name: 'slug', description: 'Category slug.' })
  @ApiOkResponse({ type: CatalogCategoryDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  categoryDetail(
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(localeCurrencySchema)) query: LocaleCurrencyQuery,
  ): Promise<CatalogCategoryDto> {
    return this.catalog.getCategoryBySlug(slug, query.locale);
  }

  @Get('brands')
  @ApiOperation({ summary: 'List brands' })
  @ApiOkResponse({ type: [CatalogBrandDto] })
  listBrands(): Promise<CatalogBrandDto[]> {
    return this.catalog.listBrands();
  }
}
