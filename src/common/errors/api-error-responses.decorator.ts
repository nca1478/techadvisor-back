import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/**
 * Documents the uniform error payload (`{ statusCode, code, message,
 * details? }`) for the common error statuses on a controller or route, so the
 * generated OpenAPI contract — and the frontend types built from it — include
 * the error format.
 */
export function ApiUniformErrorResponses(errorDto: Type<unknown>) {
  return applyDecorators(
    ApiExtraModels(errorDto),
    ApiResponse({
      status: 400,
      description: 'Bad request.',
      content: {
        'application/json': { schema: { $ref: getSchemaPath(errorDto) } },
      },
    }),
    ApiResponse({
      status: 404,
      description: 'Not found.',
      content: {
        'application/json': { schema: { $ref: getSchemaPath(errorDto) } },
      },
    }),
    ApiResponse({
      status: 500,
      description: 'Internal server error (uniform format).',
      content: {
        'application/json': { schema: { $ref: getSchemaPath(errorDto) } },
      },
    }),
  );
}
