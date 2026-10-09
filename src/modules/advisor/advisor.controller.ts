import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { OptionalJwtAuthGuard } from '../cart/optional-jwt-auth.guard.js';
import {
  feedbackBodySchema,
  productQaBodySchema,
  type FeedbackInput,
  type ProductQaInput,
} from './advisor.schemas.js';
import { AdvisorService } from './advisor.service.js';
import {
  AdvisorFeedbackRequestDto,
  AdvisorFeedbackResponseDto,
  ProductQaResponseDto,
} from './dto/advisor.dto.js';
import { resolveSessionOwner } from './session-owner.js';

/**
 * RAG product-QA advisor (see ADR 0025).
 *
 * Public endpoints, rate-limited per IP by the `advisor` throttler
 * (`ADVISOR_RATE_LIMIT_*`; the `auth` and `search` throttlers are skipped
 * here). The question is capped at 1000 chars by the body schema, bounding
 * retrieval + LLM cost per request. Ownership is optional (guests ask too):
 * it only matters when `sessionId` is set, in which case the turn is recorded
 * in that owned session (see ADR 0030).
 */
@ApiTags('advisor')
@Controller('advisor')
@UseGuards(ThrottlerGuard, OptionalJwtAuthGuard)
@SkipThrottle({ auth: true, search: true })
@ApiUniformErrorResponses(ErrorResponseDto)
@ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'Rate limit exceeded.' })
export class AdvisorController {
  constructor(
    private readonly advisor: AdvisorService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('product-qa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the advisor a question about one product (RAG, cited)' })
  @ApiOkResponse({ type: ProductQaResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Product not found or not active.' })
  answerProductQuestion(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(productQaBodySchema)) body: ProductQaInput,
  ): Promise<ProductQaResponseDto> {
    const owner = resolveSessionOwner(req, res, this.config.JWT_SECRET);
    return this.advisor.answerProductQuestion(body, owner);
  }

  @Post('feedback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a thumbs up/down vote on an advisor answer (stub)' })
  @ApiBody({ type: AdvisorFeedbackRequestDto })
  @ApiOkResponse({ type: AdvisorFeedbackResponseDto })
  recordFeedback(
    @Body(new ZodValidationPipe(feedbackBodySchema)) body: FeedbackInput,
  ): Promise<AdvisorFeedbackResponseDto> {
    // Fire-and-forget from the widget: validated, then append-only stored.
    return this.advisor.recordFeedback(body);
  }
}
