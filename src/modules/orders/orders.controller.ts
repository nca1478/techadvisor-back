import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { CurrentUser, type RequestUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CreateOrderDto, OrderResponseDto } from './dto/orders.dto.js';
import { OrdersService } from './orders.service.js';
import {
  createOrderSchema,
  orderIdParamsSchema,
  orderQuerySchema,
  type CreateOrderInput,
  type OrderIdParams,
  type OrderQuery,
} from './orders.schemas.js';

/**
 * Customer orders. Every route requires authentication and is strictly scoped
 * to the caller's own orders: other users' ids 404 exactly like unknown ids.
 * Prices and totals always come from the database — the client only sends the
 * shipping address (the cart is implicit).
 */
@ApiTags('orders')
@Controller('orders')
@UseGuards(JwtAuthGuard)
@ApiUniformErrorResponses(ErrorResponseDto)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Create an order from the user cart (reserves stock)' })
  @ApiBody({ type: CreateOrderDto })
  @ApiCreatedResponse({ type: OrderResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'Quantity exceeds available stock.' })
  @ApiUnprocessableEntityResponse({
    type: ErrorResponseDto,
    description: 'Empty cart, inactive product or invalid status transition.',
  })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
  createOrder(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(orderQuerySchema)) query: OrderQuery,
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
  ): Promise<OrderResponseDto> {
    return this.orders.createOrder(user.id, body, query);
  }

  @Get()
  @ApiOperation({ summary: "List the caller's own orders (newest first)" })
  @ApiOkResponse({ type: [OrderResponseDto] })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
  listOrders(
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(orderQuerySchema)) query: OrderQuery,
  ): Promise<OrderResponseDto[]> {
    return this.orders.listOrders(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: "Get one of the caller's own orders" })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Unknown order (or owned by another user).',
  })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
  getOrder(
    @CurrentUser() user: RequestUser,
    @Param(new ZodValidationPipe(orderIdParamsSchema)) params: OrderIdParams,
    @Query(new ZodValidationPipe(orderQuerySchema)) query: OrderQuery,
  ): Promise<OrderResponseDto> {
    return this.orders.getOrderById(user.id, params.id, query);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a PENDING_PAYMENT order (releases the stock reservation)' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({
    type: ErrorResponseDto,
    description: 'Unknown order (or owned by another user).',
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorResponseDto,
    description: 'Only PENDING_PAYMENT orders can be cancelled by the customer.',
  })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
  cancelOrder(
    @CurrentUser() user: RequestUser,
    @Param(new ZodValidationPipe(orderIdParamsSchema)) params: OrderIdParams,
    @Query(new ZodValidationPipe(orderQuerySchema)) query: OrderQuery,
  ): Promise<OrderResponseDto> {
    return this.orders.cancelOrder(user.id, params.id, query);
  }
}
