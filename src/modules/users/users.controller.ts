import { Body, Controller, Get, Patch, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { CurrentUser, type RequestUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ZodValidationPipe } from '../auth/zod-validation.pipe.js';
import { UserResponseDto } from '../auth/dto/auth.dto.js';
import { UpdateProfileRequestDto } from './dto/users.dto.js';
import { updateProfileSchema } from './users.schemas.js';
import { UsersService, type SafeUser } from './users.service.js';

/**
 * Authenticated account endpoints. Thin controller: validates auth via
 * guards and delegates to `UsersService`. Never returns `passwordHash`.
 */
@ApiTags('users')
@Controller('users')
@ApiUniformErrorResponses(ErrorResponseDto)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiOperation({ summary: 'Current authenticated user profile' })
  @ApiOkResponse({ type: UserResponseDto })
  async me(@CurrentUser() user: RequestUser): Promise<SafeUser> {
    const found = await this.users.findById(user.id);
    // The token was issued for an existing user; if the row is gone the
    // token is stale. JwtAuthGuard already rejected forged tokens, so a
    // missing row is treated as unauthorized, not 404.
    if (found === null) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return found;
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiOperation({ summary: 'Update the authenticated user profile (name and password only)' })
  @ApiOkResponse({ type: UserResponseDto })
  async updateMe(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileRequestDto,
  ): Promise<SafeUser> {
    // Thin controller: validation via Zod pipe, persistence in the service.
    // `email` is not part of the DTO/schema, so it can never be updated here.
    // The pipe is param-scoped (not `@UsePipes`): a method-scoped pipe would
    // also run against `@CurrentUser()` (`{ id, role }`) and wrongly reject it.
    return this.users.updateProfile(user.id, body);
  }
}
