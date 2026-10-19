import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Keeps the production (Supabase) database awake with a periodic trivial
 * query (see ADR 0072, reference: 05-control-asistencia-opencode
 * `modules/keepalive/`).
 *
 * - Disabled by default (`KEEPALIVE_ENABLED=false`) so local development
 *   never pings; production sets `KEEPALIVE_ENABLED=true`.
 * - Never runs under tests (`NODE_ENV=test`) so suites stay deterministic.
 * - Failures only warn: a sleeping/unreachable DB must never crash the API.
 * - The interval is unref'd and cleared on shutdown.
 */
@Injectable()
export class KeepAliveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeepAliveService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (process.env['NODE_ENV'] === 'test') {
      return;
    }
    if (!this.config.KEEPALIVE_ENABLED) {
      this.logger.log('Keep-alive disabled (KEEPALIVE_ENABLED=false)');
      return;
    }

    const intervalMinutes = this.config.KEEPALIVE_INTERVAL_MINUTES;
    void this.ping();
    this.timer = setInterval(() => void this.ping(), intervalMinutes * 60 * 1000);
    this.timer.unref();
    this.logger.log(`Database keep-alive enabled every ${String(intervalMinutes)} minutes`);
  }

  private async ping(): Promise<void> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      this.logger.debug('Keep-alive: database ping OK');
    } catch (error) {
      this.logger.warn(
        `Keep-alive: database ping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
