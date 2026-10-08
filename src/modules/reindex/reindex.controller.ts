import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import {
  ActiveEmbeddingDto,
  ReindexActivateDto,
  ReindexProgressDto,
  ReindexResumeDto,
  ReindexStartDto,
} from './dto/reindex.dto.js';
import { EmbeddingStateService } from './embedding-state.service.js';
import { ReindexService } from './reindex.service.js';
import { reindexJobParamsSchema, type ReindexJobParams } from './reindex.schemas.js';

/**
 * Back-office surface for zero-downtime embedding model switches (see
 * ADR 0023). Every route requires authentication plus role `ADMIN`.
 *
 * Procedure: update `EMBEDDING_MODEL`/`EMBEDDING_DIM` to the NEW model and
 * restart (the running API keeps serving the persisted ACTIVE model) →
 * `POST /admin/reindex` (snapshot + enqueue batches; the worker fills the
 * target column) → poll `GET /admin/reindex/jobs/:id` → when `activatable`
 * is true, `POST /admin/reindex/jobs/:id/activate`. `resume` re-enqueues
 * whatever is still off-target after failures or a stalled worker.
 */
@ApiTags('admin')
@Controller('admin/reindex')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiUniformErrorResponses(ErrorResponseDto)
export class ReindexController {
  constructor(
    private readonly reindex: ReindexService,
    private readonly state: EmbeddingStateService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start a reindex toward the configured EMBEDDING_MODEL/EMBEDDING_DIM' })
  @ApiOkResponse({ type: ReindexStartDto })
  start(): Promise<ReindexStartDto> {
    return this.reindex.startReindex();
  }

  @Get('active')
  @ApiOperation({ summary: 'Show the embedding model currently serving retrieval' })
  @ApiOkResponse({ type: ActiveEmbeddingDto })
  active(): Promise<ActiveEmbeddingDto> {
    return this.state.getActive();
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Report reindex progress (snapshot counters + live off-target count)' })
  @ApiOkResponse({ type: ReindexProgressDto })
  progress(
    @Param(new ZodValidationPipe(reindexJobParamsSchema)) params: ReindexJobParams,
  ): Promise<ReindexProgressDto> {
    return this.reindex.getProgress(params.id);
  }

  @Post('jobs/:id/activate')
  @ApiOperation({
    summary: 'Flip retrieval to the reindexed model (only at 100% with zero failures)',
  })
  @ApiOkResponse({ type: ReindexActivateDto })
  activate(
    @Param(new ZodValidationPipe(reindexJobParamsSchema)) params: ReindexJobParams,
  ): Promise<ReindexActivateDto> {
    return this.reindex.activate(params.id);
  }

  @Post('jobs/:id/resume')
  @ApiOperation({ summary: 'Re-enqueue batches for chunks still off-target' })
  @ApiOkResponse({ type: ReindexResumeDto })
  resume(
    @Param(new ZodValidationPipe(reindexJobParamsSchema)) params: ReindexJobParams,
  ): Promise<ReindexResumeDto> {
    return this.reindex.resume(params.id);
  }
}
