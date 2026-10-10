import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { escapeLabel, ObservabilityService } from './observability.service.js';

const CONFIG = {
  REDIS_URL: 'redis://localhost:6379',
  AI_CALL_LOG_RETENTION_DAYS: 90,
} as unknown as AppConfig;

function buildService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    aiCallLog: {
      groupBy: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    unansweredQuery: { groupBy: vi.fn().mockResolvedValue([]) },
    document: { groupBy: vi.fn().mockResolvedValue([]) },
    ...overrides,
  } as unknown as PrismaService;
  const service = new ObservabilityService(prisma, CONFIG);
  // Queue probes need Redis: stub to offline so unit tests never dial out.
  vi.spyOn(service, 'queueStats').mockResolvedValue({ up: false, ingestion: null, reindex: null });
  return { service, prisma };
}

describe('ObservabilityService', () => {
  it('cleanup deletes only rows past the retention window', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 7 });
    const { service } = buildService({ aiCallLog: { groupBy: vi.fn(), deleteMany } });
    const now = new Date('2026-10-10T00:00:00.000Z');
    const result = await service.cleanupOldLogs(now);
    expect(result).toEqual({ deleted: 7, retentionDays: 90 });
    const cutoff = deleteMany.mock.calls[0]?.[0]?.where?.createdAt?.lt as Date;
    expect(cutoff.toISOString()).toBe('2026-07-12T00:00:00.000Z');
  });

  it('prometheus output carries metadata only, never user content', async () => {
    const secret = 'pregunta-secreta-pii-xyz@example.com';
    const { service } = buildService({
      aiCallLog: {
        groupBy: vi.fn().mockResolvedValue([
          {
            type: 'LLM',
            provider: 'fake',
            model: 'fake-llm-v1',
            status: 'OK',
            _count: { _all: 4 },
            _avg: { latencyMs: 12.5 },
          },
        ]),
        deleteMany: vi.fn(),
      },
      unansweredQuery: {
        groupBy: vi.fn().mockResolvedValue([{ reason: 'no_evidence', _count: { _all: 2 } }]),
      },
      document: {
        groupBy: vi.fn().mockResolvedValue([{ status: 'READY', _count: { _all: 9 } }]),
      },
    });
    const text = await service.renderPrometheus();
    expect(text).toContain('techadvisor_ai_calls_total{type="LLM",provider="fake"');
    expect(text).toContain('techadvisor_ai_latency_ms_avg');
    expect(text).toContain('techadvisor_advisor_abstentions_total{reason="no_evidence"} 2');
    expect(text).toContain('techadvisor_documents_total{status="READY"} 9');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('@example.com');
  });

  it('escapeLabel neutralizes quotes and newlines in label values', () => {
    expect(escapeLabel('a"b\nc\\d')).toBe('a\\"b\\nc\\\\d');
  });
});
