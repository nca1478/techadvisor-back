import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { excerpt, groupQueries } from './query-normalize.js';
import type {
  AdvisorFeedbackListQuery,
  UnansweredGroupsQuery,
  UnansweredListQuery,
} from './admin-advisor.schemas.js';
import type {
  AdminAdvisorFeedbackDetailDto,
  AdminAdvisorFeedbackDto,
  AdminAdvisorMetricsDto,
  AdminAdvisorSessionDto,
  AdminUnansweredQueryDto,
} from './dto/admin-advisor.dto.js';

/** Excerpt caps for minimized admin surfaces (see ADR 0040). */
export const FEEDBACK_QUERY_EXCERPT = 200;
export const FEEDBACK_ANSWER_EXCERPT = 300;
export const SESSION_MESSAGE_EXCERPT = 200;
/** Bounded scan window for grouping/metrics (never a full-table walk). */
export const ADVISOR_SCAN_DEFAULT = 500;

const STATUS_RANK: Record<string, number> = { NEW: 0, IN_REVIEW: 1, RESOLVED: 2 };

type UnansweredRow = {
  id: string;
  query: string;
  productId: string | null;
  sessionId: string | null;
  reason: string;
  status: string;
  createdAt: Date;
};

type FeedbackRow = {
  id: string;
  productId: string | null;
  query: string;
  answer: string;
  abstained: boolean;
  value: string;
  createdAt: Date;
};

/**
 * Back-office improvement loop for the advisor (see ADR 0040).
 *
 * Every read is metadata-first: lists carry excerpts (never full user or
 * assistant texts), full content lives only behind explicit detail
 * endpoints, and the session link returns truncated excerpts (purged or
 * unknown sessions 404 identically). Nothing here is logged beyond counts.
 */
@Injectable()
export class AdminAdvisorService {
  private readonly logger = new Logger(AdminAdvisorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listUnanswered(query: UnansweredListQuery) {
    const where: Prisma.UnansweredQueryWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.reason !== undefined) {
      where.reason = query.reason;
    }
    if (query.productId !== undefined) {
      where.productId = query.productId;
    }
    if (query.q !== undefined) {
      where.query = { contains: query.q, mode: 'insensitive' };
    }
    const skip = (query.page - 1) * query.limit;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.unansweredQuery.count({ where }),
      this.prisma.unansweredQuery.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);
    return {
      data: rows.map(toUnansweredDto),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  /**
   * Frequency buckets of near-duplicate abstentions over a bounded newest-
   * first scan. Buckets sort by count (desc) then recency (desc); only the
   * requested page of buckets is returned with their row ids for drill-down.
   */
  async unansweredGroups(query: UnansweredGroupsQuery) {
    const where: Prisma.UnansweredQueryWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.reason !== undefined) {
      where.reason = query.reason;
    }
    const rows = await this.prisma.unansweredQuery.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.scanLimit,
    });
    const groups = groupQueries(
      rows,
      (row) => row.query,
      (row) => row.createdAt,
    );
    const skip = (query.page - 1) * query.limit;
    const page = groups.slice(skip, skip + query.limit);
    this.logger.debug(
      `admin advisor: grouped scanned=${String(rows.length)} buckets=${String(groups.length)}`,
    );
    return {
      data: page.map((group) => ({
        key: group.key,
        sample: group.sample,
        count: group.count,
        latestAt: group.latestAt,
        ids: group.items.map((item) => item.id),
      })),
      page: query.page,
      limit: query.limit,
      total: groups.length,
      totalPages: Math.max(1, Math.ceil(groups.length / query.limit)),
    };
  }

  /**
   * Forward-only triage transition (`NEW` → `IN_REVIEW` → `RESOLVED`).
   * Same-state and backward moves are rejected so resolved gaps cannot
   * silently reopen; `RESOLVED` is terminal.
   */
  async updateUnansweredStatus(id: string, status: 'NEW' | 'IN_REVIEW' | 'RESOLVED') {
    const current = await this.prisma.unansweredQuery.findUnique({ where: { id } });
    if (current === null) {
      throw new NotFoundException({ message: 'Unanswered query not found' });
    }
    const from = STATUS_RANK[current.status] ?? 0;
    const to = STATUS_RANK[status] ?? 0;
    if (to <= from) {
      throw new BadRequestException({
        message: `Cannot move unanswered query from ${current.status} to ${status}: triage only moves forward (NEW → IN_REVIEW → RESOLVED)`,
        details: { from: current.status, to: status },
      });
    }
    const updated = await this.prisma.unansweredQuery.update({ where: { id }, data: { status } });
    return toUnansweredDto(updated);
  }

  async listFeedback(query: AdvisorFeedbackListQuery) {
    const where: Prisma.AdvisorFeedbackWhereInput = {};
    if (query.value !== undefined) {
      where.value = query.value;
    }
    if (query.abstained !== undefined) {
      where.abstained = query.abstained;
    }
    if (query.productId !== undefined) {
      where.productId = query.productId;
    }
    const skip = (query.page - 1) * query.limit;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.advisorFeedback.count({ where }),
      this.prisma.advisorFeedback.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
    ]);
    return {
      data: rows.map(toFeedbackDto),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  async getFeedbackDetail(id: string): Promise<AdminAdvisorFeedbackDetailDto> {
    const row = await this.prisma.advisorFeedback.findUnique({ where: { id } });
    if (row === null) {
      throw new NotFoundException({ message: 'Advisor feedback not found' });
    }
    const minimized = toFeedbackDto(row);
    return {
      id: minimized.id,
      productId: minimized.productId,
      value: minimized.value,
      abstained: minimized.abstained,
      queryExcerpt: minimized.queryExcerpt,
      answerExcerpt: minimized.answerExcerpt,
      queryLength: minimized.queryLength,
      answerLength: minimized.answerLength,
      createdAt: minimized.createdAt,
      query: row.query,
      answer: row.answer,
    };
  }

  /**
   * Minimized conversation view for the admin panel: role, timestamp and a
   * capped excerpt per message — never full content (see ADR 0040).
   * Purged sessions (retention job) 404 exactly like unknown ids.
   */
  async getMinimizedSession(sessionId: string): Promise<AdminAdvisorSessionDto> {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (session === null) {
      throw new NotFoundException({ message: 'Chat session not found' });
    }
    const messages = await this.prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      sessionId: session.id,
      messageCount: messages.length,
      messages: messages.map((message) => ({
        role: message.role,
        excerpt: excerpt(message.content, SESSION_MESSAGE_EXCERPT),
        length: message.content.length,
        createdAt: message.createdAt,
      })),
      createdAt: session.createdAt,
    };
  }

  /**
   * Improvement-loop summary (all counts, no user content): open
   * abstentions by status/reason, vote totals with satisfaction rate, and
   * the top-10 normalized open questions by frequency.
   */
  async getMetrics(): Promise<AdminAdvisorMetricsDto> {
    const openWhere: Prisma.UnansweredQueryWhereInput = {
      status: { in: ['NEW', 'IN_REVIEW'] },
    };
    const [openUnanswered, byStatus, byReason, feedbackTotal, feedbackUp, feedbackDown, openRows] =
      await this.prisma.$transaction([
        this.prisma.unansweredQuery.count({ where: openWhere }),
        this.prisma.unansweredQuery.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.unansweredQuery.groupBy({ by: ['reason'], _count: { _all: true } }),
        this.prisma.advisorFeedback.count(),
        this.prisma.advisorFeedback.count({ where: { value: 'up' } }),
        this.prisma.advisorFeedback.count({ where: { value: 'down' } }),
        this.prisma.unansweredQuery.findMany({
          where: openWhere,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: ADVISOR_SCAN_DEFAULT,
        }),
      ]);
    const topQueries = groupQueries(
      openRows,
      (row) => row.query,
      (row) => row.createdAt,
    )
      .slice(0, 10)
      .map((group) => ({ key: group.key, sample: group.sample, count: group.count }));
    return {
      openUnanswered,
      unansweredByStatus: byStatus.map((row) => ({ key: row.status, count: row._count._all })),
      unansweredByReason: byReason.map((row) => ({ key: row.reason, count: row._count._all })),
      feedbackTotal,
      feedbackUp,
      feedbackDown,
      satisfactionRate: feedbackTotal === 0 ? null : feedbackUp / feedbackTotal,
      topQueries,
    };
  }
}

function toUnansweredDto(row: UnansweredRow): AdminUnansweredQueryDto {
  return {
    id: row.id,
    query: row.query,
    productId: row.productId,
    sessionId: row.sessionId,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function toFeedbackDto(row: FeedbackRow): AdminAdvisorFeedbackDto {
  return {
    id: row.id,
    productId: row.productId,
    value: row.value,
    abstained: row.abstained,
    queryExcerpt: excerpt(row.query, FEEDBACK_QUERY_EXCERPT),
    answerExcerpt: excerpt(row.answer, FEEDBACK_ANSWER_EXCERPT),
    queryLength: row.query.length,
    answerLength: row.answer.length,
    createdAt: row.createdAt,
  };
}
