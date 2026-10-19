import { ApiProperty } from '@nestjs/swagger';

export class RegisterRequestDto {
  @ApiProperty({ example: 'ada@example.com', description: 'Unique email address.' })
  email!: string;

  @ApiProperty({
    example: 'correct-horse-battery-staple-42',
    minLength: 10,
    description: 'Password (min 10 chars). Never logged, never returned.',
  })
  password!: string;

  @ApiProperty({ example: 'Ada Lovelace', required: false })
  name?: string;
}

export class LoginRequestDto {
  @ApiProperty({ example: 'ada@example.com' })
  email!: string;

  @ApiProperty({ example: 'correct-horse-battery-staple-42' })
  password!: string;
}

export class GoogleLoginRequestDto {
  @ApiProperty({
    description: 'GIS ID token (JWT). One of idToken/accessToken is required.',
    required: false,
  })
  idToken?: string;

  @ApiProperty({
    description:
      'Google OAuth2 access token (popup flow, mobile-friendly). One of idToken/accessToken is required.',
    required: false,
  })
  accessToken?: string;
}

export class RefreshRequestDto {
  @ApiProperty({ description: 'Opaque refresh token issued by login/refresh.' })
  refreshToken!: string;
}

export class TokenPairResponseDto {
  @ApiProperty({ description: 'Short-lived JWT for Authorization: Bearer.' })
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'], example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expiresIn!: number;

  @ApiProperty({ description: 'Opaque rotating refresh token (shown once, stored hashed).' })
  refreshToken!: string;
}

export class UserResponseDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;

  @ApiProperty({ example: 'ada@example.com' })
  email!: string;

  @ApiProperty({ example: 'Ada Lovelace', nullable: true })
  name!: string | null;

  @ApiProperty({ enum: ['CUSTOMER', 'ADMIN'], example: 'CUSTOMER' })
  role!: string;

  @ApiProperty({ enum: ['LOCAL', 'GOOGLE'], example: 'LOCAL' })
  provider!: string;

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-10-06T12:00:00.000Z' })
  updatedAt!: Date;
}

export class LogoutResponseDto {
  @ApiProperty({ example: true })
  ok!: boolean;
}
