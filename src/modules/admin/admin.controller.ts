import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AdminService } from './admin.service.js';
import {
  adjustInventorySchema,
  adminOrderListQuerySchema,
  adminProductListQuerySchema,
  createBrandSchema,
  createCategorySchema,
  createProductSchema,
  replaceProductImagesSchema,
  updateBrandSchema,
  updateCategorySchema,
  updateOrderStatusSchema,
  updateProductSchema,
  updateProductStatusSchema,
  uuidParamsSchema,
  type AdjustInventoryInput,
  type AdminOrderListQuery,
  type AdminProductListQuery,
  type CreateBrandInput,
  type CreateCategoryInput,
  type CreateProductInput,
  type ReplaceProductImagesInput,
  type UpdateBrandInput,
  type UpdateCategoryInput,
  type UpdateOrderStatusInput,
  type UpdateProductInput,
  type UpdateProductStatusInput,
  type UuidParams,
} from './admin.schemas.js';
import {
  AdminBrandDto,
  AdminCategoryDto,
  AdminInventoryDto,
  AdminInventoryMovementDto,
  AdminOrderDto,
  AdminOrderListDto,
  AdminProductDto,
  AdminProductListDto,
} from './dto/admin.dto.js';

/**
 * Back-office surface (see ADR 0013). Every route requires authentication
 * plus role `ADMIN` — a `CUSTOMER` token gets 403, a missing/invalid token
 * gets 401. Products are never physically deleted (archival is a status
 * change); every stock adjustment appends an `InventoryMovement` row.
 */
@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiUniformErrorResponses(ErrorResponseDto)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('ping')
  @ApiOperation({ summary: 'Admin-only probe (role check)' })
  @ApiOkResponse({ description: 'Reachable only with role ADMIN.' })
  ping(): { ok: boolean } {
    return { ok: true };
  }

  // --- Products ----------------------------------------------------------

  @Get('products')
  @ApiOperation({ summary: 'List products (every status) with filters and pagination' })
  @ApiOkResponse({ type: AdminProductListDto })
  listProducts(
    @Query(new ZodValidationPipe(adminProductListQuerySchema)) query: AdminProductListQuery,
  ): Promise<AdminProductListDto> {
    return this.admin.listProducts(query);
  }

  @Post('products')
  @ApiOperation({ summary: 'Create a product (specs validated against the category schema)' })
  @ApiCreatedResponse({ type: AdminProductDto })
  createProduct(
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ): Promise<AdminProductDto> {
    return this.admin.createProduct(body);
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'Get a product by id (any status)' })
  @ApiOkResponse({ type: AdminProductDto })
  getProduct(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
  ): Promise<AdminProductDto> {
    return this.admin.getProductById(params.id);
  }

  @Patch('products/:id')
  @ApiOperation({ summary: 'Edit a product (prices/translations replace the whole set)' })
  @ApiOkResponse({ type: AdminProductDto })
  updateProduct(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ): Promise<AdminProductDto> {
    return this.admin.updateProduct(params.id, body);
  }

  @Patch('products/:id/status')
  @ApiOperation({ summary: 'Change product status (archival is logical, never a delete)' })
  @ApiOkResponse({ type: AdminProductDto })
  updateProductStatus(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
    @Body(new ZodValidationPipe(updateProductStatusSchema)) body: UpdateProductStatusInput,
  ): Promise<AdminProductDto> {
    return this.admin.updateProductStatus(params.id, body.status);
  }

  @Put('products/:id/images')
  @ApiOperation({
    summary: 'Replace the complete ordered image set (add, remove, reorder in one call)',
  })
  @ApiOkResponse({ type: AdminProductDto })
  replaceProductImages(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
    @Body(new ZodValidationPipe(replaceProductImagesSchema)) body: ReplaceProductImagesInput,
  ): Promise<AdminProductDto> {
    return this.admin.replaceProductImages(params.id, body);
  }

  // --- Categories --------------------------------------------------------

  @Get('categories')
  @ApiOperation({ summary: 'List categories with translations' })
  @ApiOkResponse({ type: [AdminCategoryDto] })
  listCategories() {
    return this.admin.listCategories();
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create a category' })
  @ApiCreatedResponse({ type: AdminCategoryDto })
  createCategory(@Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryInput) {
    return this.admin.createCategory(body);
  }

  @Get('categories/:id')
  @ApiOperation({ summary: 'Get a category by id (for the back-office edit screen)' })
  @ApiOkResponse({ type: AdminCategoryDto })
  getCategory(@Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams) {
    return this.admin.getCategoryById(params.id);
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Edit a category (translations replace the whole set)' })
  @ApiOkResponse({ type: AdminCategoryDto })
  updateCategory(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryInput,
  ) {
    return this.admin.updateCategory(params.id, body);
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a category (409 while subcategories or products exist)' })
  @ApiNoContentResponse({ description: 'Category deleted.' })
  async deleteCategory(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
  ): Promise<void> {
    await this.admin.deleteCategory(params.id);
  }

  // --- Brands ------------------------------------------------------------

  @Get('brands')
  @ApiOperation({ summary: 'List brands' })
  @ApiOkResponse({ type: [AdminBrandDto] })
  listBrands() {
    return this.admin.listBrands();
  }

  @Post('brands')
  @ApiOperation({ summary: 'Create a brand' })
  @ApiCreatedResponse({ type: AdminBrandDto })
  createBrand(@Body(new ZodValidationPipe(createBrandSchema)) body: CreateBrandInput) {
    return this.admin.createBrand(body);
  }

  @Patch('brands/:id')
  @ApiOperation({ summary: 'Edit a brand' })
  @ApiOkResponse({ type: AdminBrandDto })
  updateBrand(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
    @Body(new ZodValidationPipe(updateBrandSchema)) body: UpdateBrandInput,
  ) {
    return this.admin.updateBrand(params.id, body);
  }

  @Delete('brands/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a brand (409 while products reference it)' })
  @ApiNoContentResponse({ description: 'Brand deleted.' })
  async deleteBrand(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
  ): Promise<void> {
    await this.admin.deleteBrand(params.id);
  }

  // --- Inventory ---------------------------------------------------------

  @Get('inventory/:id')
  @ApiOperation({ summary: 'Get exact stock levels for a product' })
  @ApiOkResponse({ type: AdminInventoryDto })
  getInventory(@Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams) {
    return this.admin.getInventory(params.id);
  }

  @Patch('inventory/:id')
  @ApiOperation({
    summary: 'Adjust physical stock by a signed delta (appends an InventoryMovement row)',
  })
  @ApiOkResponse({ type: AdminInventoryDto })
  adjustInventory(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
    @Body(new ZodValidationPipe(adjustInventorySchema)) body: AdjustInventoryInput,
  ) {
    return this.admin.adjustInventory(params.id, body);
  }

  @Get('inventory/:id/movements')
  @ApiOperation({ summary: 'List stock movements for a product (newest first)' })
  @ApiOkResponse({ type: [AdminInventoryMovementDto] })
  listMovements(@Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams) {
    return this.admin.listMovements(params.id);
  }

  // --- Orders ------------------------------------------------------------

  @Get('orders')
  @ApiOperation({ summary: 'List orders (any user) with status/date filters' })
  @ApiOkResponse({ type: AdminOrderListDto })
  listOrders(
    @Query(new ZodValidationPipe(adminOrderListQuerySchema)) query: AdminOrderListQuery,
  ): Promise<AdminOrderListDto> {
    return this.admin.listOrders(query);
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Get an order by id (frozen prices survive product archival)' })
  @ApiOkResponse({ type: AdminOrderDto })
  getOrder(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
  ): Promise<AdminOrderDto> {
    return this.admin.getOrderById(params.id);
  }

  @Patch('orders/:id/status')
  @ApiOperation({
    summary: 'Change order status (state machine enforced; PAID only via webhook)',
  })
  @ApiOkResponse({ type: AdminOrderDto })
  updateOrderStatus(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
    @Body(new ZodValidationPipe(updateOrderStatusSchema)) body: UpdateOrderStatusInput,
  ): Promise<AdminOrderDto> {
    return this.admin.updateOrderStatus(params.id, body.status);
  }
}
