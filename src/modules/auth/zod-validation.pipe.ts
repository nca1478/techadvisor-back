import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { type ZodType } from 'zod';

/**
 * Validates the request body against a Zod schema. On failure throws a 400
 * with the uniform payload `{ statusCode, code, message, details? }` (built
 * by the global `HttpExceptionFilter` from this exception).
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
    );
    throw new BadRequestException({
      message: issues.join('; '),
      details: issues,
    });
  }
}
