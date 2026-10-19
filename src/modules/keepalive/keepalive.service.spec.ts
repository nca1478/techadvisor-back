import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { KeepAliveService } from './keepalive.service.js';

const PREV_NODE_ENV = process.env['NODE_ENV'];

function buildService(config: Partial<AppConfig>, queryRawImpl?: () => Promise<{ ok: number }>) {
  const queryRaw = vi.fn(() => Promise.resolve({ ok: 1 }));
  if (queryRawImpl !== undefined) {
    queryRaw.mockImplementation(queryRawImpl);
  }
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const fullConfig = {
    KEEPALIVE_ENABLED: false,
    KEEPALIVE_INTERVAL_MINUTES: 60,
    ...config,
  } as AppConfig;
  return { service: new KeepAliveService(prisma, fullConfig), queryRaw };
}

beforeEach(() => {
  process.env['NODE_ENV'] = 'development';
  vi.useRealTimers();
});

describe('KeepAliveService', () => {
  it('stays idle when KEEPALIVE_ENABLED=false (development default)', () => {
    const { service, queryRaw } = buildService({ KEEPALIVE_ENABLED: false });

    service.onModuleInit();

    expect(queryRaw).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('pings once on boot when enabled', () => {
    const { service, queryRaw } = buildService({ KEEPALIVE_ENABLED: true });

    service.onModuleInit();

    expect(queryRaw).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('never throws when the ping fails (only warns)', () => {
    const { service, queryRaw } = buildService({ KEEPALIVE_ENABLED: true }, () =>
      Promise.reject(new Error('db down')),
    );
    expect(() => {
      service.onModuleInit();
    }).not.toThrow();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('clears the interval on destroy', () => {
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const { service } = buildService({ KEEPALIVE_ENABLED: true });

    service.onModuleInit();
    service.onModuleDestroy();
    service.onModuleDestroy();

    expect(clearSpy).toHaveBeenCalledTimes(1);
    clearSpy.mockRestore();
  });

  it('never runs under NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test';
    const { service, queryRaw } = buildService({
      KEEPALIVE_ENABLED: true,
    });

    service.onModuleInit();

    expect(queryRaw).not.toHaveBeenCalled();
    service.onModuleDestroy();
    process.env['NODE_ENV'] = PREV_NODE_ENV ?? 'development';
  });
});
