import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CompatibilityService } from './compatibility.service.js';
import { compatibilityCheckBodySchema } from './compatibility.schemas.js';
import type { CompatibilityCheckInput } from './compatibility.schemas.js';
import {
  CompatibilityCheckRequestDto,
  CompatibilityCheckResponseDto,
} from './dto/compatibility.dto.js';

/**
 * Deterministic product compatibility (no auth, no LLM).
 *
 * Evaluates `specs`-based rules (socket, RAM, storage, PSU wattage, build
 * shape) over the given products. `compatible` is true only when every rule
 * passed with complete data — any warning (missing specs) makes it false.
 */
@ApiTags('compatibility')
@Controller('compatibility')
@ApiUniformErrorResponses(ErrorResponseDto)
export class CompatibilityController {
  constructor(private readonly compatibility: CompatibilityService) {}

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check compatibility of a set of products (deterministic, no LLM)' })
  @ApiBody({ type: CompatibilityCheckRequestDto })
  @ApiOkResponse({ type: CompatibilityCheckResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'Unknown product id.' })
  checkCompatibility(
    @Body(new ZodValidationPipe(compatibilityCheckBodySchema)) body: CompatibilityCheckInput,
  ): Promise<CompatibilityCheckResponseDto> {
    return this.compatibility.check(body);
  }
}
