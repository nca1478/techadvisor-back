import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Req,
  UseGuards,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { CurrentUser, type RequestUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CheckoutResponseDto, CreateCheckoutDto, WebhookAckDto } from './dto/payments.dto.js';
import { PaymentsService } from './payments.service.js';
import { checkoutSchema, type CheckoutInput } from './payments.schemas.js';

/**
 * Stripe test-mode payments (see ADR 0012).
 *
 * - `POST /payments/checkout` (authenticated) starts a hosted Checkout
 *   Session for one of the caller's `PENDING_PAYMENT` orders. Money always
 *   comes from the database; the client only names the order.
 * - `POST /payments/webhook` (public, raw body) is the ONLY path that moves
 *   an order to `PAID`. The Stripe signature is verified over the raw bytes;
 *   a missing/invalid signature returns 400 and changes nothing.
 */
@ApiTags('payments')
@Controller('payments')
@ApiUniformErrorResponses(ErrorResponseDto)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('checkout')
  @ApiOperation({
    summary: 'Start a Stripe Checkout Session for one of your PENDING_PAYMENT orders',
  })
  @ApiBody({ type: CreateCheckoutDto })
  @ApiCreatedResponse({ type: CheckoutResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
  @ApiServiceUnavailableResponse({
    type: ErrorResponseDto,
    description: 'Payments are not configured (no Stripe test keys).',
  })
  @UseGuards(JwtAuthGuard)
  createCheckout(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(checkoutSchema)) body: CheckoutInput,
  ): Promise<CheckoutResponseDto> {
    return this.payments.createCheckout(user.id, body);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stripe webhook (signature-verified). The only source of truth for PAID.',
  })
  @ApiOkResponse({ type: WebhookAckDto })
  handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<WebhookAckDto> {
    const rawBody = req.rawBody;
    if (rawBody === undefined) {
      // Server misconfiguration (`rawBody: true` missing in main.ts): never
      // verify against re-serialized JSON, fail loudly instead.
      throw new InternalServerErrorException('Webhook raw body is unavailable');
    }
    return this.payments.handleWebhook(rawBody, signature).then(() => ({ received: true }));
  }
}
