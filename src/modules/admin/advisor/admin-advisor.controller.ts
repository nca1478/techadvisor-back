import { Controller, Get, Param, Patch, Body, Query, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../../common/errors/api-error-responses.decorator.js';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { uuidParamsSchema, type UuidParams } from '../admin.schemas.js';
import { AdminAdvisorService } from './admin-advisor.service.js';
import {
  advisorFeedbackListQuerySchema,
  unansweredGroupsQuerySchema,
  unansweredListQuerySchema,
  updateUnansweredStatusSchema,
  type AdvisorFeedbackListQuery,
  type UnansweredGroupsQuery,
  type UnansweredListQuery,
  type UpdateUnansweredStatusInput,
} from './admin-advisor.schemas.js';
import {
  AdminAdvisorFeedbackDetailDto,
  AdminAdvisorFeedbackListDto,
  AdminAdvisorMetricsDto,
  AdminAdvisorSessionDto,
  AdminUnansweredGroupListDto,
  AdminUnansweredQueryDto,
  AdminUnansweredQueryListDto,
} from './dto/admin-advisor.dto.js';

/**
 * Advisor improvement loop (see ADR 0040). Every route requires
 * authentication plus role `ADMIN` — a `CUSTOMER` token gets 403, a
 * missing/invalid token gets 401. Lists are minimized (excerpts, counts);
 * full user/assistant texts live only behind explicit detail endpoints.
 */
@ApiTags('admin')
@Controller('admin/advisor')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiUniformErrorResponses(ErrorResponseDto)
export class AdminAdvisorController {
  constructor(private readonly advisor: AdminAdvisorService) {}

  @Get('unanswered')
  @ApiOperation({ summary: 'List abstentions under triage (NEW/IN_REVIEW/RESOLVED), newest first' })
  @ApiOkResponse({ type: AdminUnansweredQueryListDto })
  listUnanswered(
    @Query(new ZodValidationPipe(unansweredListQuerySchema)) query: UnansweredListQuery,
  ) {
    return this.advisor.listUnanswered(query);
  }

  @Get('unanswered/groups')
  @ApiOperation({
    summary: 'Abstentions grouped by normalized question text, most frequent first',
  })
  @ApiOkResponse({ type: AdminUnansweredGroupListDto })
  unansweredGroups(
    @Query(new ZodValidationPipe(unansweredGroupsQuerySchema)) query: UnansweredGroupsQuery,
  ) {
    return this.advisor.unansweredGroups(query);
  }

  @Patch('unanswered/:id')
  @ApiOperation({
    summary:
      'Move an abstention forward in triage (NEW → IN_REVIEW → RESOLVED; same-state is a no-op)',
  })
  @ApiOkResponse({ type: AdminUnansweredQueryDto })
  updateUnansweredStatus(
    @Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams,
    @Body(new ZodValidationPipe(updateUnansweredStatusSchema)) body: UpdateUnansweredStatusInput,
  ) {
    return this.advisor.updateUnansweredStatus(params.id, body.status);
  }

  @Get('feedback')
  @ApiOperation({ summary: 'List thumbs up/down votes (minimized excerpts), newest first' })
  @ApiOkResponse({ type: AdminAdvisorFeedbackListDto })
  listFeedback(
    @Query(new ZodValidationPipe(advisorFeedbackListQuerySchema)) query: AdvisorFeedbackListQuery,
  ) {
    return this.advisor.listFeedback(query);
  }

  @Get('feedback/:id')
  @ApiOperation({ summary: 'Full feedback vote (admin-only, e.g. to draft a corpus document)' })
  @ApiOkResponse({ type: AdminAdvisorFeedbackDetailDto })
  getFeedback(@Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams) {
    return this.advisor.getFeedbackDetail(params.id);
  }

  @Get('sessions/:id')
  @ApiOperation({
    summary: 'Minimized conversation view (excerpts only; purged sessions 404)',
  })
  @ApiOkResponse({ type: AdminAdvisorSessionDto })
  getSession(@Param(new ZodValidationPipe(uuidParamsSchema)) params: UuidParams) {
    return this.advisor.getMinimizedSession(params.id);
  }

  @Get('metrics')
  @ApiOperation({
    summary: 'Improvement-loop summary: open abstentions, satisfaction, frequent gaps',
  })
  @ApiOkResponse({ type: AdminAdvisorMetricsDto })
  getMetrics() {
    return this.advisor.getMetrics();
  }
}
