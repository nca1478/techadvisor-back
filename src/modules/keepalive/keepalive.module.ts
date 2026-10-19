import { Module } from '@nestjs/common';
import { KeepAliveService } from './keepalive.service.js';

/**
 * Periodic `SELECT 1` against PostgreSQL to keep the Supabase free-tier
 * database from pausing on inactivity (see ADR 0072).
 *
 * No controller: the service owns a single unref'd interval and is a no-op
 * unless `KEEPALIVE_ENABLED=true` (production only; development default is
 * disabled because the local database never sleeps).
 */
@Module({
  providers: [KeepAliveService],
})
export class KeepAliveModule {}
