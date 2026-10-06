import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorCode } from '../errors/error-code.enum.js';

interface UniformErrorBody {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.UNPROCESSABLE_ENTITY,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.TOO_MANY_REQUESTS,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

interface RequestWithId extends Request {
  id?: string;
}

/**
 * Global exception filter. Every error leaving the API — HTTP exceptions and
 * unexpected failures alike — is normalized to the uniform payload
 * `{ statusCode, code, message, details? }`.
 *
 * Internal details of unexpected errors are never leaked: they are logged
 * server-side (with the requestId when available) and replaced with a generic
 * message for the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId>();

    const requestId =
      typeof request.id === 'string' && request.id.length > 0 ? request.id : undefined;

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();
      const body = toUniformBody(statusCode, payload);
      this.log(statusCode, request, requestId, exception);
      response.status(statusCode).json(body);
      return;
    }

    // Non-HTTP (unexpected) error: log the original, return a generic 500.
    const error = exception instanceof Error ? exception : new Error(String(exception));
    console.log(
      JSON.stringify({
        level: 'error',
        msg: 'Unhandled exception',
        requestId,
        method: request.method,
        url: request.originalUrl,
        error: error.message,
      }),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    } satisfies UniformErrorBody);
  }

  private log(
    statusCode: number,
    request: { method: string; originalUrl: string },
    requestId: string | undefined,
    exception: HttpException,
  ): void {
    // 5xx from HttpException still deserve a server-side entry with the cause.
    if (statusCode >= 500) {
      console.log(
        JSON.stringify({
          level: 'error',
          msg: 'HTTP exception',
          requestId,
          method: request.method,
          url: request.originalUrl,
          statusCode,
          error: exception.message,
        }),
      );
    }
  }
}

function toUniformBody(statusCode: number, payload: unknown): UniformErrorBody {
  const code = STATUS_TO_CODE[statusCode] ?? ErrorCode.INTERNAL_ERROR;

  if (typeof payload === 'string') {
    return { statusCode, code, message: payload };
  }

  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const message = typeof record['message'] === 'string' ? record['message'] : 'Request failed';
    const details = record['details'] ?? record['error'];
    // Nest validation errors arrive as `message: string[]`; join them into
    // the uniform `message` and keep the array in `details`.
    if (Array.isArray(record['message'])) {
      return {
        statusCode,
        code,
        message: record['message'].map(String).join('; '),
        details: record['message'],
      };
    }
    const body: UniformErrorBody = { statusCode, code, message };
    if (details !== undefined) {
      body.details = details;
    }
    return body;
  }

  return { statusCode, code, message: 'Request failed' };
}
