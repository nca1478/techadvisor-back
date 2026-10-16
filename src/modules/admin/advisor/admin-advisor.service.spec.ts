import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminAdvisorService } from './admin-advisor.service.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-id',
    query: '¿Cuánto dura la batería?',
    productId: null,
    sessionId: null,
    reason: 'no_evidence',
    status: 'NEW',
    createdAt: new Date('2026-10-10T10:00:00Z'),
    ...overrides,
  };
}

function feedbackRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fb-id',
    productId: null,
    sessionId: null,
    query: 'q',
    answer: 'a',
    abstained: false,
    value: 'up',
    createdAt: new Date('2026-10-10T10:00:00Z'),
    ...overrides,
  };
}

describe('AdminAdvisorService (unit, mocked database)', () => {
  const unansweredQuery = {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
  };
  const advisorFeedback = { count: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() };
  const chatSession = { findUnique: vi.fn() };
  const chatMessage = { findMany: vi.fn() };
  const prisma = {
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    unansweredQuery,
    advisorFeedback,
    chatSession,
    chatMessage,
  };
  // justificado: PrismaService is a database facade; the mock covers exactly the delegates used.
  const service = new AdminAdvisorService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists abstentions newest-first with pagination metadata', async () => {
    unansweredQuery.count.mockResolvedValue(3);
    unansweredQuery.findMany.mockResolvedValue([row()]);
    const result = await service.listUnanswered({ page: 1, limit: 20 });
    expect(result.total).toBe(3);
    expect(result.totalPages).toBe(1);
    expect(result.data[0]?.status).toBe('NEW');
    expect(unansweredQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    );
  });

  it('groups near-duplicate abstentions by normalized text', async () => {
    unansweredQuery.findMany.mockResolvedValue([
      row({ id: 'a', query: '¿Cuánto dura la batería?' }),
      row({ id: 'b', query: 'cuanto dura la bateria' }),
      row({ id: 'c', query: '¿Tiene garantía?' }),
    ]);
    const result = await service.unansweredGroups({ scanLimit: 500, page: 1, limit: 20 });
    expect(result.total).toBe(2);
    expect(result.data[0]).toMatchObject({ key: 'cuanto dura la bateria', count: 2 });
    expect(result.data[0]?.ids).toEqual(['a', 'b']);
  });

  it('moves triage forward, no-ops same-state, and rejects backward and unknown rows', async () => {
    unansweredQuery.findUnique.mockResolvedValue(row({ status: 'NEW' }));
    unansweredQuery.update.mockImplementation(({ data }: { data: { status: string } }) =>
      Promise.resolve(row({ status: data.status })),
    );
    const updated = await service.updateUnansweredStatus('row-id', 'IN_REVIEW');
    expect(updated.status).toBe('IN_REVIEW');

    unansweredQuery.findUnique.mockResolvedValue(row({ status: 'IN_REVIEW' }));
    const noop = await service.updateUnansweredStatus('row-id', 'IN_REVIEW');
    expect(noop.status).toBe('IN_REVIEW');
    expect(unansweredQuery.update).toHaveBeenCalledTimes(1);
    await expect(service.updateUnansweredStatus('row-id', 'NEW')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    unansweredQuery.findUnique.mockResolvedValue(null);
    await expect(service.updateUnansweredStatus('row-id', 'RESOLVED')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('minimizes feedback lists to excerpts with full lengths', async () => {
    advisorFeedback.count.mockResolvedValue(1);
    advisorFeedback.findMany.mockResolvedValue([
      feedbackRow({ query: 'q'.repeat(500), answer: 'a'.repeat(900) }),
    ]);
    const result = await service.listFeedback({ page: 1, limit: 20 });
    expect(result.data[0]?.queryExcerpt.length).toBeLessThanOrEqual(201);
    expect(result.data[0]?.queryLength).toBe(500);
    expect(result.data[0]?.answerLength).toBe(900);
    expect(result.data[0]).not.toHaveProperty('query');
  });

  it('returns minimized session excerpts and 404s unknown sessions', async () => {
    chatSession.findUnique.mockResolvedValue({
      id: 's1',
      createdAt: new Date('2026-10-10T09:00:00Z'),
    });
    chatMessage.findMany.mockResolvedValue([
      {
        role: 'USER',
        content: 'u'.repeat(400),
        createdAt: new Date('2026-10-10T09:01:00Z'),
      },
    ]);
    const session = await service.getMinimizedSession('s1');
    expect(session.messageCount).toBe(1);
    expect(session.messages[0]?.length).toBe(400);
    expect(session.messages[0]?.excerpt.length).toBeLessThanOrEqual(201);

    chatSession.findUnique.mockResolvedValue(null);
    await expect(service.getMinimizedSession('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports metrics with null satisfaction while no votes exist', async () => {
    unansweredQuery.count.mockResolvedValue(2);
    unansweredQuery.groupBy
      .mockResolvedValueOnce([{ status: 'NEW', _count: { _all: 2 } }])
      .mockResolvedValueOnce([{ reason: 'no_evidence', _count: { _all: 2 } }]);
    advisorFeedback.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    unansweredQuery.findMany.mockResolvedValue([row()]);
    const metrics = await service.getMetrics();
    expect(metrics.openUnanswered).toBe(2);
    expect(metrics.satisfactionRate).toBeNull();
    expect(metrics.topQueries).toHaveLength(1);
  });
});
