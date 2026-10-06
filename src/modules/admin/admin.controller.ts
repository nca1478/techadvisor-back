import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';

/**
 * Minimal admin surface for this phase: a single probe route guarded with
 * `@Roles('ADMIN')`. Full admin CRUD (products, orders) arrives in Fase 1
 * follow-ups. A CUSTOMER token here must receive 403.
 */
@ApiTags('admin')
@Controller('admin')
@ApiUniformErrorResponses(ErrorResponseDto)
export class AdminController {
  @Get('ping')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Admin-only probe (role check)' })
  @ApiOkResponse({ description: 'Reachable only with role ADMIN.' })
  ping(): { ok: boolean } {
    return { ok: true };
  }
}
