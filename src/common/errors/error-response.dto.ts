import { ApiProperty } from '@nestjs/swagger';
import { ErrorCode } from './error-code.enum.js';

/**
 * Uniform error payload returned by every endpoint (see the global
 * `HttpExceptionFilter`): `{ statusCode, code, message, details? }`.
 * Documented in OpenAPI so the frontend can generate types from it.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 404, description: 'HTTP status code of the error.' })
  statusCode!: number;

  @ApiProperty({
    enum: ErrorCode,
    example: ErrorCode.NOT_FOUND,
    description: 'Stable machine-readable error code.',
  })
  code!: ErrorCode;

  @ApiProperty({
    example: 'Resource not found',
    description: 'Human-readable error message (English, technical).',
  })
  message!: string;

  @ApiProperty({
    example: { resource: 'Product' },
    required: false,
    description: 'Optional extra details (validation errors, resource names).',
  })
  details?: unknown;
}
