import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards, UsePipes } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ErrorResponseDto } from '../../common/errors/error-response.dto.js';
import { ApiUniformErrorResponses } from '../../common/errors/api-error-responses.decorator.js';
import {
  PasswordResetCleanupResponseDto,
  PasswordResetConfirmDto,
  PasswordResetOkDto,
  PasswordResetRequestDto,
  PasswordResetVerifyDto,
  PasswordResetVerifyResponseDto,
} from './dto/password-reset.dto.js';
import {
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  passwordResetVerifySchema,
} from './password-reset.schemas.js';
import { PasswordResetService } from './password-reset.service.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';

/**
 * Public OTP password-reset endpoints (LOCAL users only). `request` never
 * reveals whether the email exists (anti-enumeration); `verify` issues a
 * single-use resetToken; `confirm` sets the new password and notifies by mail.
 */
@ApiTags('auth')
@Controller('auth/password')
@UseGuards(ThrottlerGuard)
@ApiUniformErrorResponses(ErrorResponseDto)
@ApiTooManyRequestsResponse({ type: ErrorResponseDto, description: 'Rate limit exceeded.' })
export class PasswordResetController {
  constructor(private readonly resets: PasswordResetService) {}

  @Post('request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password-reset OTP code by email' })
  @ApiOkResponse({ type: PasswordResetOkDto })
  @UsePipes(new ZodValidationPipe(passwordResetRequestSchema))
  request(@Body() body: PasswordResetRequestDto): Promise<PasswordResetOkDto> {
    return this.resets.request(body);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify the OTP code and get a reset token' })
  @ApiOkResponse({ type: PasswordResetVerifyResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @UsePipes(new ZodValidationPipe(passwordResetVerifySchema))
  verify(@Body() body: PasswordResetVerifyDto): Promise<PasswordResetVerifyResponseDto> {
    return this.resets.verify(body);
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password with a verified reset token' })
  @ApiOkResponse({ type: PasswordResetOkDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @UsePipes(new ZodValidationPipe(passwordResetConfirmSchema))
  reset(@Body() body: PasswordResetConfirmDto): Promise<PasswordResetOkDto> {
    return this.resets.confirm(body);
  }

  @Post('cleanup')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Purge dead password-reset challenges (admin job trigger)' })
  @ApiOkResponse({ type: PasswordResetCleanupResponseDto })
  cleanup(): Promise<PasswordResetCleanupResponseDto> {
    return this.resets.cleanupExpired();
  }
}
