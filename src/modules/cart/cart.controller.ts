import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser, type RequestUser } from '../auth/current-user.decorator.js';
import { OptionalJwtAuthGuard, getOptionalUser } from './optional-jwt-auth.guard.js';
import {
  addCartItemSchema,
  cartQuerySchema,
  updateCartItemSchema,
  type AddCartItemInput,
  type CartQuery,
  type UpdateCartItemInput,
} from './cart.schemas.js';
import { AddCartItemDto, CartResponseDto, UpdateCartItemDto } from './dto/cart.dto.js';
import { CartService, type CartOwner } from './cart.service.js';
import {
  clearGuestSessionCookie,
  newSignedSid,
  readGuestSessionId,
  setGuestSessionCookie,
} from './guest-session.js';

const cartItemParamsSchema = z.object({
  productId: z.uuid({ error: 'productId must be a valid UUID' }),
});

/**
 * Guest + authenticated carts. `GET /cart` and the item writes work
 * anonymously (guest identified by the signed httpOnly `sid` cookie, issued
 * on first use) and authenticated (Bearer token selects the user cart).
 * `POST /cart/merge` requires auth and folds the guest cart into the user
 * cart (see ADR 0010). Money always comes from the database — the client can
 * only ever send product ids and quantities.
 */
@ApiTags('cart')
@Controller('cart')
@UseGuards(OptionalJwtAuthGuard)
@ApiUniformErrorResponses(ErrorResponseDto)
export class CartController {
  constructor(
    private readonly carts: CartService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get the current cart (guest via sid cookie, or user cart)' })
  @ApiOkResponse({ type: CartResponseDto })
  getCart(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query(new ZodValidationPipe(cartQuerySchema)) query: CartQuery,
  ): Promise<CartResponseDto> {
    const owner = this.resolveOwner(req, res);
    return this.carts.getCart(owner, query.locale, query.currency);
  }

  @Post('items')
  @ApiOperation({ summary: 'Add a product to the cart (quantity is added to any existing line)' })
  @ApiBody({ type: AddCartItemDto })
  @ApiOkResponse({ type: CartResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Unknown or non-active product.' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'Quantity exceeds available stock.' })
  addItem(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query(new ZodValidationPipe(cartQuerySchema)) query: CartQuery,
    @Body(new ZodValidationPipe(addCartItemSchema)) body: AddCartItemInput,
  ): Promise<CartResponseDto> {
    const owner = this.resolveOwner(req, res);
    return this.carts.addItem(owner, body.productId, body.qty, query.locale, query.currency);
  }

  @Patch('items/:productId')
  @ApiOperation({ summary: 'Set the quantity of a cart line' })
  @ApiBody({ type: UpdateCartItemDto })
  @ApiOkResponse({ type: CartResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Unknown line or product.' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'Quantity exceeds available stock.' })
  updateItem(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param(new ZodValidationPipe(cartItemParamsSchema)) params: { productId: string },
    @Query(new ZodValidationPipe(cartQuerySchema)) query: CartQuery,
    @Body(new ZodValidationPipe(updateCartItemSchema)) body: UpdateCartItemInput,
  ): Promise<CartResponseDto> {
    const owner = this.resolveOwner(req, res);
    return this.carts.setItemQty(owner, params.productId, body.qty, query.locale, query.currency);
  }

  @Delete('items/:productId')
  @ApiOperation({ summary: 'Remove a line from the cart (idempotent)' })
  @ApiOkResponse({ type: CartResponseDto })
  removeItem(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param(new ZodValidationPipe(cartItemParamsSchema)) params: { productId: string },
    @Query(new ZodValidationPipe(cartQuerySchema)) query: CartQuery,
  ): Promise<CartResponseDto> {
    const owner = this.resolveOwner(req, res);
    return this.carts.removeItem(owner, params.productId, query.locale, query.currency);
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Merge the guest cart into the authenticated user cart' })
  @ApiOkResponse({ type: CartResponseDto, description: 'Merged user cart; sid cookie cleared.' })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
  merge(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: RequestUser,
    @Query(new ZodValidationPipe(cartQuerySchema)) query: CartQuery,
  ): Promise<CartResponseDto> {
    const sessionId = readGuestSessionId(req, this.config.JWT_SECRET);
    if (sessionId !== null) {
      clearGuestSessionCookie(res);
    }
    return this.carts.mergeGuestIntoUser(user.id, sessionId, query.locale, query.currency);
  }

  /**
   * Authenticated requests resolve to the user cart; anonymous ones to the
   * guest cart, issuing a fresh signed `sid` cookie when needed.
   */
  private resolveOwner(req: Request, res: Response): CartOwner {
    const user = getOptionalUser(req as unknown as Record<string, unknown>);
    if (user !== null) {
      return { kind: 'user', userId: user.id };
    }
    const sessionId = readGuestSessionId(req, this.config.JWT_SECRET);
    if (sessionId !== null) {
      return { kind: 'guest', sessionId };
    }
    const fresh = newSignedSid(this.config.JWT_SECRET);
    setGuestSessionCookie(res, fresh.signed);
    return { kind: 'guest', sessionId: fresh.sessionId };
  }
}
