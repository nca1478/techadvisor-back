import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards, UsePipes } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import { AuthService } from './auth.service.js';
import { loginSchema, refreshSchema, registerSchema } from './auth.schemas.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import {
  LoginRequestDto,
  LogoutResponseDto,
  RefreshRequestDto,
  RegisterRequestDto,
  TokenPairResponseDto,
  UserResponseDto,
} from './dto/auth.dto.js';

/**
 * Public authentication endpoints. Rate-limited per IP (guard at controller
 * level, limits from `AUTH_RATE_LIMIT_*`): brute-force protection for
 * register/login/refresh without touching the rest of the API.
 */
@ApiTags('auth')
@Controller('auth')
@UseGuards(ThrottlerGuard)
@ApiUniformErrorResponses(ErrorResponseDto)
@ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'Rate limit exceeded.' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new customer account' })
  @ApiCreatedResponse({ description: 'Account created (role is always CUSTOMER).' })
  @UsePipes(new ZodValidationPipe(registerSchema))
  async register(@Body() body: RegisterRequestDto): Promise<{
    user: UserResponseDto;
    tokens: TokenPairResponseDto;
  }> {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiOkResponse({
    description: 'Authenticated. Failures return 401 without revealing if the email exists.',
  })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(@Body() body: LoginRequestDto): Promise<{
    user: UserResponseDto;
    tokens: TokenPairResponseDto;
  }> {
    return this.auth.login(body);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and get a new access token' })
  @ApiOkResponse({ description: 'New token pair; the presented refresh token is revoked.' })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @UsePipes(new ZodValidationPipe(refreshSchema))
  async refresh(@Body() body: RefreshRequestDto): Promise<{ tokens: TokenPairResponseDto }> {
    return this.auth.refresh(body);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the presented refresh token' })
  @ApiOkResponse({ type: LogoutResponseDto })
  @UsePipes(new ZodValidationPipe(refreshSchema))
  async logout(@Body() body: RefreshRequestDto): Promise<LogoutResponseDto> {
    return this.auth.logout(body);
  }
}
