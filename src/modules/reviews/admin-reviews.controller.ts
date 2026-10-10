import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
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
import { AdminReviewDto, AdminReviewListDto } from './dto/reviews.dto.js';
import { ReviewsService } from './reviews.service.js';
import {
  adminReviewListQuerySchema,
  moderateReviewSchema,
  reviewIdParamsSchema,
  type AdminReviewListQuery,
  type ModerateReviewInput,
  type ReviewIdParams,
} from './reviews.schemas.js';

/**
 * Back-office review moderation (see ADR 0037). Every route requires
 * authentication plus role `ADMIN`. Publishing or rejecting a review
 * re-syncs the REVIEW corpus document and refreshes the cached pros/cons
 * summary inline (best-effort side effects inside the service).
 */
@ApiTags('admin')
@Controller('admin/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiBearerAuth()
@ApiUniformErrorResponses(ErrorResponseDto)
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'List reviews with status/product filters (newest first)' })
  @ApiOkResponse({ type: AdminReviewListDto })
  listReviews(
    @Query(new ZodValidationPipe(adminReviewListQuerySchema)) query: AdminReviewListQuery,
  ): Promise<AdminReviewListDto> {
    return this.reviews.listForAdmin(query);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Publish or reject a review (refreshes corpus + summary)' })
  @ApiOkResponse({ type: AdminReviewDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Review not found.' })
  moderateReview(
    @Param(new ZodValidationPipe(reviewIdParamsSchema)) params: ReviewIdParams,
    @Body(new ZodValidationPipe(moderateReviewSchema)) body: ModerateReviewInput,
  ): Promise<AdminReviewDto> {
    return this.reviews.moderateReview(params.id, body.status);
  }
}
