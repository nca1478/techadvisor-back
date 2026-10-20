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
import { getOptionalUser, OptionalJwtAuthGuard } from '../cart/optional-jwt-auth.guard.js';
import { AiEnabledGuard } from './ai-enabled.guard.js';
import {
  feedbackBodySchema,
  productQaBodySchema,
  type FeedbackInput,
  type ProductQaInput,
} from './advisor.schemas.js';
import { AdvisorService } from './advisor.service.js';
import { compareBodySchema, type CompareInput } from './compare/compare.schemas.js';
import { CompareService } from './compare/compare.service.js';
import {
  AdvisorFeedbackRequestDto,
  AdvisorFeedbackResponseDto,
  ProductQaResponseDto,
} from './dto/advisor.dto.js';
import { CompareRequestDto, CompareResponseDto } from './dto/compare.dto.js';
import { SupportRequestDto, SupportResponseDto } from './dto/support.dto.js';
import { resolveSessionOwner } from './session-owner.js';
import { supportBodySchema, type SupportInput } from './support/support.schemas.js';
import { SupportService } from './support/support.service.js';

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
@UseGuards(ThrottlerGuard, OptionalJwtAuthGuard, AiEnabledGuard)
@SkipThrottle({ auth: true, search: true })
@ApiUniformErrorResponses(ErrorResponseDto)
@ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'Rate limit exceeded.' })
export class AdvisorController {
  constructor(
    private readonly advisor: AdvisorService,
    private readonly compare: CompareService,
    private readonly support: SupportService,
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

  @Post('compare')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compare 2-3 products: SQL table + cited LLM summary' })
  @ApiBody({ type: CompareRequestDto })
  @ApiOkResponse({ type: CompareResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Product not found or not active.' })
  compareProducts(
    @Body(new ZodValidationPipe(compareBodySchema)) body: CompareInput,
  ): Promise<CompareResponseDto> {
    // Same advisor throttler and optional-guest ownership as product-QA:
    // the table and figures always come from SQL, the LLM only explains.
    return this.compare.compare(body);
  }

  @Post('support')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the post-sale support advisor (policies, cited)' })
  @ApiBody({ type: SupportRequestDto })
  @ApiOkResponse({ type: SupportResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Order not found or not owned.' })
  answerSupportQuestion(
    @Req() req: Request,
    @Body(new ZodValidationPipe(supportBodySchema)) body: SupportInput,
  ): Promise<SupportResponseDto> {
    // Order-scoped questions need the authenticated caller; anonymous users
    // may only ask general policy questions (the service 401s otherwise).
    const user = getOptionalUser(req as unknown as Record<string, unknown>);
    return this.support.answerSupportQuestion(body, user);
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
