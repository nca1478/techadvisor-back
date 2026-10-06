import { Controller, Get, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { CurrentUser, type RequestUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { UserResponseDto } from '../auth/dto/auth.dto.js';
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
}
