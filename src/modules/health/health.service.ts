import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { INGESTION_QUEUE_NAME } from '../ingestion/ingestion.constants.js';
import { parseRedisConnection } from '../ingestion/ingestion.queue.js';
import { AiCallLoggerService } from '../observability/ai-call-logger.service.js';

export interface ExtendedHealth {
  status: 'ok';
  db: 'up' | 'down';
  redis: 'up' | 'down';
  ingestion: 'up' | 'down' | 'unknown';
  ingestionCounts?: { waiting: number; active: number; delayed: number; failed: number };
  ai: 'up' | 'degraded' | 'unknown';
  aiStates?: Array<{ provider: string; model: string; status: string }>;
}

const REDIS_PING_TIMEOUT_MS = 2000;

/**
 * Liveness + dependency reachability probe (see ADR 0039).
 *
 * - `db`: trivial `SELECT 1` (unchanged).
 * - `redis`: one `PING` with a short timeout (never blocks the probe).
 * - `ingestion`: BullMQ queue readability with a short-lived connection;
 *   `down` when Redis is down, `unknown` only when the queue lookup itself
 *   fails while Redis answers.
 * - `ai`: last known instrumented-call outcome from `AiCallLoggerService`
 *   (in-memory; never a live provider call per healthcheck).
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly callLogger?: AiCallLoggerService | null,
  ) {}

  async check(): Promise<ExtendedHealth> {
    const db = await this.checkDb();
    const redis = await this.checkRedis();
    const ingestion =
      redis === 'up' ? await this.checkIngestionQueue() : { status: 'down' as const };
    const ai = this.callLogger?.availability() ?? 'unknown';
    const aiStates = this.callLogger
      ?.lastKnownStates(10)
      .map((state) => ({ provider: state.provider, model: state.model, status: state.status }));
    return {
      status: 'ok',
      db,
      redis,
      ingestion: ingestion.status,
      ...('counts' in ingestion && ingestion.counts !== undefined
        ? { ingestionCounts: ingestion.counts }
        : {}),
      ai,
      ...(aiStates !== undefined && aiStates.length > 0 ? { aiStates } : {}),
    };
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<'up' | 'down'> {
    let redis: Redis | null = null;
    try {
      // Short-lived client: never a persistent connection from the probe.
      redis = new Redis(this.config.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: REDIS_PING_TIMEOUT_MS,
        lazyConnect: true,
      });
      await withTimeout(redis.ping(), REDIS_PING_TIMEOUT_MS);
      return 'up';
    } catch (error) {
      this.logger.debug(
        `health: redis down: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
      );
      return 'down';
    } finally {
      if (redis !== null) {
        redis.disconnect();
      }
    }
  }

  private async checkIngestionQueue(): Promise<{
    status: 'up' | 'unknown';
    counts?: { waiting: number; active: number; delayed: number; failed: number };
  }> {
    let connection: { host: string; port: number };
    try {
      connection = parseRedisConnection(this.config.REDIS_URL);
    } catch {
      return { status: 'unknown' };
    }
    const queue = new Queue(INGESTION_QUEUE_NAME, {
      connection: { ...connection, maxRetriesPerRequest: null },
    });
    try {
      const counts = await withTimeout(
        queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        REDIS_PING_TIMEOUT_MS,
      );
      return {
        status: 'up',
        counts: {
          waiting: counts.waiting,
          active: counts.active,
          delayed: counts.delayed,
          failed: counts.failed,
        },
      };
    } catch {
      return { status: 'unknown' };
    } finally {
      await queue.close().catch(() => undefined);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('timed out'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}
