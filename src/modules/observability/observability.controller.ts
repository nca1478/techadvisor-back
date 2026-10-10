import { Controller, Get, Header, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AiCallLogCleanupResponseDto } from './dto/observability.dto.js';
import { ObservabilityService } from './observability.service.js';

/**
 * Operational visibility (see ADR 0039): Prometheus metrics and the
 * `ai_call_logs` retention trigger. Every route requires authentication
 * plus role `ADMIN` — metrics labels carry only provider/model metadata,
 * never user content, but depths and error rates are still back-office only.
 */
@ApiTags('metrics')
@Controller('metrics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@ApiUniformErrorResponses(ErrorResponseDto)
@ApiUnauthorizedResponse({ type: ErrorResponseDto, description: 'Authentication required.' })
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4')
  @ApiOperation({
    summary:
      'Prometheus metrics: AI latency/errors per provider+model, abstentions, queues, documents',
  })
  @ApiOkResponse({ description: 'Prometheus text exposition format.' })
  async metrics(): Promise<string> {
    return this.observability.renderPrometheus();
  }

  @Post('cleanup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Purge ai_call_logs rows past AI_CALL_LOG_RETENTION_DAYS (admin job trigger)',
  })
  @ApiOkResponse({ type: AiCallLogCleanupResponseDto })
  cleanupLogs(): Promise<AiCallLogCleanupResponseDto> {
    return this.observability.cleanupOldLogs();
  }
}
