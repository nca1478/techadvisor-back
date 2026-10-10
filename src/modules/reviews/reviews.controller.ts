import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { JwtAuthGuard, type RequestUser } from '../auth/jwt-auth.guard.js';
import { ReviewDto, ReviewListDto, ReviewSummaryResponseDto } from './dto/reviews.dto.js';
import { ReviewsService } from './reviews.service.js';
import {
  createReviewSchema,
  reviewListQuerySchema,
  reviewProductParamsSchema,
  type CreateReviewInput,
  type ReviewListQuery,
  type ReviewProductParams,
} from './reviews.schemas.js';
/**
 * Public review surface (see ADR 0037). Creation requires authentication
 * and a proven purchase (PAID/DELIVERED order containing the product, one
 * review per product); reads are public and return PUBLISHED rows only —
 * never author ids, never moderation states.
 */
@ApiTags('reviews')
@Controller('reviews')
@ApiUniformErrorResponses(ErrorResponseDto)
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a review (buyers of this product only, once per product)' })
  @ApiCreatedResponse({ type: ReviewDto })
  createReview(
    @Req() req: { user: RequestUser },
    @Body(new ZodValidationPipe(createReviewSchema)) body: CreateReviewInput,
  ): Promise<ReviewDto> {
    return this.reviews.createReview(req.user.id, body);
  }

  @Get('product/:productId')
  @ApiOperation({ summary: 'List published reviews of a product (paginated, newest first)' })
  @ApiOkResponse({ type: ReviewListDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Product not found or not active.' })
  listPublished(
    @Param(new ZodValidationPipe(reviewProductParamsSchema)) params: ReviewProductParams,
    @Query(new ZodValidationPipe(reviewListQuerySchema)) query: ReviewListQuery,
  ): Promise<ReviewListDto> {
    return this.reviews.listPublished(params.productId, query);
  }

  @Get('product/:productId/summary')
  @ApiOperation({
    summary: 'Cached pros/cons summary (summary null while below the review minimum)',
  })
  @ApiOkResponse({ type: ReviewSummaryResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Product not found or not active.' })
  async getSummary(
    @Param(new ZodValidationPipe(reviewProductParamsSchema)) params: ReviewProductParams,
  ): Promise<ReviewSummaryResponseDto> {
    // Always a JSON object (never an empty body): `summary` is null while
    // published reviews are below the minimum, so clients parse uniformly.
    const summary = await this.reviews.getSummary(params.productId);
    return { summary };
  }
}
