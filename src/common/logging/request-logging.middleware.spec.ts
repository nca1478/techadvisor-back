import { EventEmitter } from 'node:events';
import { RequestLoggingMiddleware, REQUEST_ID_HEADER } from './request-logging.middleware.js';
import type { AppConfig } from '../../config/env.schema.js';

function createMocks(enabled: boolean) {
  const middleware = new RequestLoggingMiddleware({
    REQUEST_LOGGING_ENABLED: enabled,
  } as AppConfig);
  const req = {
    headers: {},
    method: 'GET',
    originalUrl: '/api/v1/health',
  } as unknown as Parameters<RequestLoggingMiddleware['use']>[0];
  const res = new EventEmitter() as unknown as Parameters<RequestLoggingMiddleware['use']>[1] & {
    statusCode: number;
  };
  const setHeaderCalls: Array<[string, string]> = [];
  res.setHeader = ((name: string, value: string) => {
    setHeaderCalls.push([name, value]);
    return res;
  }) as typeof res.setHeader;
  res.statusCode = 200;
  let nextCalled = false;
  return {
    middleware,
    req,
    res,
    setHeaderCalls,
    next: () => (nextCalled = true),
    wasNextCalled: () => nextCalled,
  };
}

describe('RequestLoggingMiddleware', () => {
  it('logs on finish when REQUEST_LOGGING_ENABLED is true', () => {
    const { middleware, req, res, setHeaderCalls, next, wasNextCalled } = createMocks(true);
    const spy = vitest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      middleware.use(req, res, next);
      (res as unknown as EventEmitter).emit('finish');

      expect(wasNextCalled()).toBe(true);
      expect(setHeaderCalls[0]?.[0]).toBe(REQUEST_ID_HEADER);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0]?.[0]).toContain('"request completed"');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps x-request-id but stays silent when REQUEST_LOGGING_ENABLED is false', () => {
    const { middleware, req, res, setHeaderCalls, next, wasNextCalled } = createMocks(false);
    const spy = vitest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      middleware.use(req, res, next);
      (res as unknown as EventEmitter).emit('finish');

      expect(wasNextCalled()).toBe(true);
      expect(setHeaderCalls[0]?.[0]).toBe(REQUEST_ID_HEADER);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
