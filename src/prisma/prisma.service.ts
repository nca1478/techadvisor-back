import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { APP_CONFIG } from '../config/app-config.module.js';
import type { AppConfig } from '../config/env.schema.js';

/**
 * NestJS-managed Prisma client (Prisma 7 driver-adapter setup).
 * Connects on module init and disconnects on destroy so the app never leaks
 * database connections on shutdown.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
