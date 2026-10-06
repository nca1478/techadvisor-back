import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../errors/error-code.enum.js';
import { HttpExceptionFilter } from './http-exception.filter.js';

function hostFor(
  method = 'GET',
  url = '/api/v1/things',
): {
  host: ArgumentsHost;
  statusFn: ReturnType<typeof vi.fn>;
  jsonFn: ReturnType<typeof vi.fn>;
} {
  const jsonFn = vi.fn();
  const statusFn = vi.fn(() => ({ json: jsonFn }));
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method, url, headers: {} }),
      getResponse: () => ({ status: statusFn }),
    }),
  } as unknown as ArgumentsHost;
  return { host, statusFn, jsonFn };
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes an HttpException with a string payload', () => {
    const { host, statusFn, jsonFn } = hostFor();
    filter.catch(new HttpException('Gone fishing', HttpStatus.NOT_FOUND), host);

    expect(statusFn).toHaveBeenCalledWith(404);
    expect(jsonFn).toHaveBeenCalledWith({
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      message: 'Gone fishing',
    });
  });

  it('keeps validation details from an object payload', () => {
    const { host, statusFn, jsonFn } = hostFor('POST', '/api/v1/things');
    filter.catch(
      new HttpException(
        { message: ['name should not be empty', 'price must be a number'], statusCode: 400 },
        HttpStatus.BAD_REQUEST,
      ),
      host,
    );

    expect(statusFn).toHaveBeenCalledWith(400);
    expect(jsonFn).toHaveBeenCalledWith({
      statusCode: 400,
      code: ErrorCode.BAD_REQUEST,
      message: 'name should not be empty; price must be a number',
      details: ['name should not be empty', 'price must be a number'],
    });
  });

  it('maps an unexpected error to INTERNAL_ERROR without leaking details', () => {
    const { host, statusFn, jsonFn } = hostFor();
    filter.catch(new Error('postgres password=hunter2 exploded'), host);

    expect(statusFn).toHaveBeenCalledWith(500);
    expect(jsonFn).toHaveBeenCalledWith({
      statusCode: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });
    expect(JSON.stringify(jsonFn.mock.calls)).not.toContain('hunter2');
  });

  it('maps non-Error throws to INTERNAL_ERROR', () => {
    const { host, statusFn, jsonFn } = hostFor();
    filter.catch('string kaboom', host);

    expect(statusFn).toHaveBeenCalledWith(500);
    expect(jsonFn).toHaveBeenCalledWith({
      statusCode: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });
  });
});
