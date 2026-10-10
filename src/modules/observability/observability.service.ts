import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { INGESTION_QUEUE_NAME } from '../ingestion/ingestion.constants.js';
import { parseRedisConnection } from '../ingestion/ingestion.queue.js';
import { REINDEX_QUEUE_NAME } from '../reindex/reindex.constants.js';

export interface AiCallStatRow {
  type: string;
  provider: string;
  model: string;
  status: string;
  count: number;
  avgLatencyMs: number | null;
}

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface QueueStats {
  up: boolean;
  ingestion: QueueCounts | null;
  reindex: QueueCounts | null;
}

/**
 * Operational observability queries (see ADR 0039).
 *
 * Every query is metadata-only: counts and averages over `ai_call_logs`,
 * `unanswered_queries` (abstentions by reason) and `documents` (by status),
 * plus BullMQ queue depths. No prompt, question, answer or user content is
 * ever selected — the SELECT lists below are the whole contract.
 */
@Injectable()
export class ObservabilityService {
  private readonly logger = new Logger(ObservabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async aiCallStats(): Promise<AiCallStatRow[]> {
    const groups = await this.prisma.aiCallLog.groupBy({
      by: ['type', 'provider', 'model', 'status'],
      _count: { _all: true },
      _avg: { latencyMs: true },
    });
    return groups.map((group) => ({
      type: group.type,
      provider: group.provider,
      model: group.model,
      status: group.status,
      count: group._count._all,
      avgLatencyMs: group._avg.latencyMs,
    }));
  }

  async abstentionByReason(): Promise<Array<{ reason: string; count: number }>> {
    const groups = await this.prisma.unansweredQuery.groupBy({
      by: ['reason'],
      _count: { _all: true },
    });
    return groups.map((group) => ({ reason: group.reason, count: group._count._all }));
  }

  async documentsByStatus(): Promise<Array<{ status: string; count: number }>> {
    const groups = await this.prisma.document.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return groups.map((group) => ({ status: group.status, count: group._count._all }));
  }

  /**
   * BullMQ queue depths probed on demand with a short-lived connection
   * (never a persistent worker from the API process). When Redis is down
   * the result is `{ up: false, ...null }` — never a throw, so `/metrics`
   * stays available during an outage.
   */
  async queueStats(): Promise<QueueStats> {
    let connection: { host: string; port: number };
    try {
      connection = parseRedisConnection(this.config.REDIS_URL);
    } catch (error) {
      this.logger.warn(
        `metrics: invalid REDIS_URL: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
      );
      return { up: false, ingestion: null, reindex: null };
    }
    const readCounts = async (name: string): Promise<QueueCounts | null> => {
      const queue = new Queue(name, {
        connection: { ...connection, maxRetriesPerRequest: null },
      });
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        return {
          waiting: counts.waiting,
          active: counts.active,
          delayed: counts.delayed,
          failed: counts.failed,
        };
      } catch {
        return null;
      } finally {
        await queue.close().catch(() => undefined);
      }
    };
    const [ingestion, reindex] = await Promise.all([
      readCounts(INGESTION_QUEUE_NAME),
      readCounts(REINDEX_QUEUE_NAME),
    ]);
    return { up: ingestion !== null || reindex !== null, ingestion, reindex };
  }

  /**
   * Renders the Prometheus text exposition format by hand (no new
   * dependency, see ADR 0039). Label values are limited to provider/model/
   * type/status/reason/queue — never user content, never free-form text.
   */
  async renderPrometheus(): Promise<string> {
    const [calls, abstentions, documents, queues] = await Promise.all([
      this.aiCallStats(),
      this.abstentionByReason(),
      this.documentsByStatus(),
      this.queueStats(),
    ]);
    const lines: string[] = [];
    lines.push('# HELP techadvisor_ai_calls_total Total instrumented AI/retrieval calls.');
    lines.push('# TYPE techadvisor_ai_calls_total counter');
    for (const row of calls) {
      lines.push(
        `techadvisor_ai_calls_total{type="${escapeLabel(row.type)}",provider="${escapeLabel(row.provider)}",model="${escapeLabel(row.model)}",status="${escapeLabel(row.status)}"} ${String(row.count)}`,
      );
    }
    lines.push('# HELP techadvisor_ai_latency_ms_avg Average latency per provider/model (ms).');
    lines.push('# TYPE techadvisor_ai_latency_ms_avg gauge');
    for (const row of calls) {
      if (row.avgLatencyMs === null) {
        continue;
      }
      lines.push(
        `techadvisor_ai_latency_ms_avg{type="${escapeLabel(row.type)}",provider="${escapeLabel(row.provider)}",model="${escapeLabel(row.model)}"} ${row.avgLatencyMs.toFixed(1)}`,
      );
    }
    lines.push('# HELP techadvisor_advisor_abstentions_total Abstentions by reason.');
    lines.push('# TYPE techadvisor_advisor_abstentions_total counter');
    for (const row of abstentions) {
      lines.push(
        `techadvisor_advisor_abstentions_total{reason="${escapeLabel(row.reason)}"} ${String(row.count)}`,
      );
    }
    lines.push('# HELP techadvisor_documents_total Documents by ingestion status.');
    lines.push('# TYPE techadvisor_documents_total gauge');
    for (const row of documents) {
      lines.push(
        `techadvisor_documents_total{status="${escapeLabel(row.status)}"} ${String(row.count)}`,
      );
    }
    lines.push('# HELP techadvisor_queue_jobs BullMQ queue depth by state.');
    lines.push('# TYPE techadvisor_queue_jobs gauge');
    const queueEntries: Array<[string, QueueCounts | null]> = [
      ['ingestion', queues.ingestion],
      ['reindex', queues.reindex],
    ];
    for (const [queue, counts] of queueEntries) {
      if (counts === null) {
        continue;
      }
      for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
        lines.push(
          `techadvisor_queue_jobs{queue="${queue}",state="${state}"} ${String(counts[state])}`,
        );
      }
    }
    lines.push('# HELP techadvisor_queue_up Whether queue depths could be read (1) or not (0).');
    lines.push('# TYPE techadvisor_queue_up gauge');
    lines.push(`techadvisor_queue_up ${queues.up ? '1' : '0'}`);
    return `${lines.join('\n')}\n`;
  }

  /**
   * Retention purge for `ai_call_logs` (see ADR 0039): deletes rows older
   * than `AI_CALL_LOG_RETENTION_DAYS`. Idempotent; returns the deleted
   * count for the admin trigger response.
   */
  async cleanupOldLogs(
    now: Date = new Date(),
  ): Promise<{ deleted: number; retentionDays: number }> {
    const retentionDays = this.config.AI_CALL_LOG_RETENTION_DAYS;
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.aiCallLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    this.logger.debug(`observability cleanup: deleted=${String(result.count)}`);
    return { deleted: result.count, retentionDays };
  }
}

/** Prometheus label escaping for the closed metadata values we emit. */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').slice(0, 200);
}
