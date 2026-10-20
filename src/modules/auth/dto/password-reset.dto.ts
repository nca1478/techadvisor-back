import { ApiProperty } from '@nestjs/swagger';

export class PasswordResetRequestDto {
  @ApiProperty({ example: 'ada@example.com' })
  email!: string;
}

export class PasswordResetVerifyDto {
  @ApiProperty({ example: 'ada@example.com' })
  email!: string;

  @ApiProperty({ example: '664572', description: '6-digit OTP from the email.' })
  code!: string;
}

export class PasswordResetConfirmDto {
  @ApiProperty({ example: 'ada@example.com' })
  email!: string;

  @ApiProperty({ description: 'Opaque token issued by the verify step.' })
  resetToken!: string;

  @ApiProperty({ minLength: 10, description: 'New password (min 10 chars).' })
  password!: string;

  @ApiProperty({ description: 'Must match password.' })
  confirmPassword!: string;
}

export class PasswordResetOkDto {
  @ApiProperty({ example: true })
  ok!: boolean;
}

export class PasswordResetVerifyResponseDto {
  @ApiProperty({ description: 'Single-use token for the reset step.' })
  resetToken!: string;

  @ApiProperty({ example: 900, description: 'Reset token lifetime in seconds.' })
  expiresIn!: number;
}

export class PasswordResetCleanupResponseDto {
  @ApiProperty({ example: 3, description: 'Dead challenges deleted.' })
  deleted!: number;
}
