import { ApiProperty } from '@nestjs/swagger';

/**
 * Body for `PATCH /users/me`. Email is deliberately absent: it cannot be
 * updated through this endpoint.
 */
export class UpdateProfileRequestDto {
  @ApiProperty({ example: 'Ada Lovelace', required: false })
  name?: string;

  @ApiProperty({
    example: 'correct-horse-battery-staple-42',
    minLength: 10,
    required: false,
    description: 'New password (min 10 chars). Never logged, never returned.',
  })
  password?: string;
}
