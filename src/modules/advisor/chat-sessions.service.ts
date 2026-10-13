import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { ChatMessageRole, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ChatMessageInput } from './chat-sessions.schemas.js';

/**
 * Owner of a chat session: either the authenticated user id or the verified
 * guest `sid` session id (uuid part only, never the signed cookie value).
 * Exactly one variant is set, mirroring the `chat_sessions` CHECK.
 */
export type ChatSessionOwner =
  { kind: 'user'; userId: string } | { kind: 'guest'; anonSessionId: string };

export interface ChatSessionSummary {
  id: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** First USER message truncated for list labels; absent when none yet. */
  preview?: string;
}

/** Max session-preview length, in sync with the frontend `truncateSessionPreview`. */
export const CHAT_SESSION_PREVIEW_MAX_LENGTH = 60;

/**
 * Truncates the first user message into a one-line session label.
 * mantener en sync con frontend: `truncateSessionPreview` en
 * `src/lib/api/advisor.ts` (same single-line collapse, length and ellipsis).
 */
export function toSessionPreview(
  content: string,
  maxLength: number = CHAT_SESSION_PREVIEW_MAX_LENGTH,
): string | undefined {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (singleLine.length === 0) {
    return undefined;
  }
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

export interface ChatStoredMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  citations: unknown[];
  products: unknown[];
  createdAt: Date;
}

export interface ChatSessionHistory extends ChatSessionSummary {
  messages: ChatStoredMessage[];
}

/**
 * Persistence for advisor chat sessions (see ADR 0029).
 *
 * Every read/write re-checks ownership against the stored `userId` /
 * `anonSessionId`: unknown ids and cross-user ids 404 identically, so a
 * session is never accessible by another user (not even admins — there is no
 * bypass). Messages are append-only; the per-session count and per-message
 * length caps come from config. Only metadata reaches the logs — message
 * content may contain user text and is never logged.
 */
@Injectable()
export class ChatSessionsService {
  private readonly logger = new Logger(ChatSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createSession(owner: ChatSessionOwner): Promise<ChatSessionSummary> {
    const session = await this.prisma.chatSession.create({
      data:
        owner.kind === 'user' ? { userId: owner.userId } : { anonSessionId: owner.anonSessionId },
      include: { _count: { select: { messages: true } } },
    });
    this.logger.debug(`advisor chat: session created kind=${owner.kind} messages=0`);
    return toSummary(session.id, 0, session.createdAt, session.updatedAt);
  }

  /**
   * Lists the caller's own sessions, newest first. Authenticated users only
   * (the controller enforces JWT); anonymous sessions are reachable solely
   * through their own `sid` cookie via `getSessionHistory`.
   */
  async listUserSessions(userId: string): Promise<ChatSessionSummary[]> {
    const rows = await this.prisma.chatSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { messages: true } } },
    });
    const previews = await this.previewBySession(rows.map((row) => row.id));
    return rows.map((row) =>
      toSummary(row.id, row._count.messages, row.createdAt, row.updatedAt, previews.get(row.id)),
    );
  }

  /**
   * First USER message per session (oldest first, one extra query for the
   * whole list) so session labels show the conversation topic instead of a
   * bare date. Sessions without a user message get no entry.
   */
  private async previewBySession(sessionIds: string[]): Promise<Map<string, string>> {
    const previews = new Map<string, string>();
    if (sessionIds.length === 0) {
      return previews;
    }
    const firsts = await this.prisma.chatMessage.findMany({
      where: { sessionId: { in: sessionIds }, role: 'USER' },
      orderBy: { createdAt: 'asc' },
      select: { sessionId: true, content: true },
    });
    for (const row of firsts) {
      if (previews.has(row.sessionId)) {
        continue;
      }
      const preview = toSessionPreview(row.content);
      if (preview !== undefined) {
        previews.set(row.sessionId, preview);
      }
    }
    return previews;
  }

  /**
   * Physically deletes one owned session. Its messages cascade at the
   * database level (`ChatMessage.session`, `onDelete: Cascade`), so no
   * orphan rows remain. Analytics rows that only carry the session id as a
   * plain field (`UnansweredQuery.sessionId`) are intentionally left
   * untouched. Unknown ids and foreign sessions 404 identically, like every
   * other session-scoped operation.
   */
  async deleteSession(sessionId: string, owner: ChatSessionOwner): Promise<void> {
    await this.findOwnedSessionOrThrow(sessionId, owner);
    await this.prisma.chatSession.delete({ where: { id: sessionId } });
    this.logger.debug(`advisor chat: session deleted kind=${owner.kind}`);
  }

  /** Reads one session with its full history (oldest message first). */
  async getSessionHistory(sessionId: string, owner: ChatSessionOwner): Promise<ChatSessionHistory> {
    const session = await this.findOwnedSessionOrThrow(sessionId, owner);
    const messages = await this.prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });
    const firstUser = messages.find((message) => message.role === 'USER');
    const preview = firstUser ? toSessionPreview(firstUser.content) : undefined;
    return {
      ...toSummary(session.id, messages.length, session.createdAt, session.updatedAt, preview),
      messages: messages.map(toStoredMessage),
    };
  }

  /** Appends one message, enforcing the per-message length and per-session count caps. */
  async addMessage(
    sessionId: string,
    owner: ChatSessionOwner,
    input: ChatMessageInput,
  ): Promise<ChatStoredMessage> {
    const session = await this.findOwnedSessionOrThrow(sessionId, owner);
    if (input.content.length > this.config.ADVISOR_MESSAGE_MAX_LENGTH) {
      throw new BadRequestException({
        message: `content must be at most ${String(this.config.ADVISOR_MESSAGE_MAX_LENGTH)} characters long`,
      });
    }
    const count = await this.prisma.chatMessage.count({ where: { sessionId: session.id } });
    if (count >= this.config.ADVISOR_SESSION_MAX_MESSAGES) {
      throw new BadRequestException({
        message: `session already holds the maximum of ${String(this.config.ADVISOR_SESSION_MAX_MESSAGES)} messages`,
      });
    }
    const created = await this.prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        role: input.role,
        content: input.content,
        citations: (input.citations ?? []) as Prisma.InputJsonValue,
        products: (input.products ?? []) as Prisma.InputJsonValue,
      },
    });
    // Metadata only: never the message content.
    this.logger.debug(
      `advisor chat: message appended role=${input.role} total=${String(count + 1)}`,
    );
    return toStoredMessage(created);
  }

  /**
   * Purges anonymous sessions older than `ADVISOR_ANON_SESSION_RETENTION_DAYS`
   * (message rows cascade). Authenticated sessions are never touched.
   * Runs as a job (scheduler/external cron calls this method); idempotent.
   */
  async cleanupExpiredAnonymousSessions(now: Date = new Date()): Promise<{ deleted: number }> {
    const cutoff = new Date(
      now.getTime() - this.config.ADVISOR_ANON_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const result = await this.prisma.chatSession.deleteMany({
      where: { userId: null, createdAt: { lt: cutoff } },
    });
    this.logger.debug(`advisor chat: cleanup deleted=${String(result.count)}`);
    return { deleted: result.count };
  }

  /**
   * Verifies the caller owns the session without returning it. Used by
   * writers (e.g. product-QA) that must reject cross-user ids BEFORE any
   * costly work (retrieval, LLM calls). Same 404 semantics as the readers.
   */
  async assertSessionOwned(sessionId: string, owner: ChatSessionOwner): Promise<void> {
    await this.findOwnedSessionOrThrow(sessionId, owner);
  }

  /**
   * Loads the session and verifies the caller owns it. Unknown ids, user
   * sessions presented with a guest identity (and vice versa), and ids owned
   * by another user all throw the same 404 — ownership is never disclosed.
   */
  private async findOwnedSessionOrThrow(
    sessionId: string,
    owner: ChatSessionOwner,
  ): Promise<{ id: string; createdAt: Date; updatedAt: Date }> {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (session === null) {
      throw new NotFoundException({ message: 'Chat session not found' });
    }
    const owned =
      owner.kind === 'user'
        ? session.userId === owner.userId
        : session.userId === null && session.anonSessionId === owner.anonSessionId;
    if (!owned) {
      throw new NotFoundException({ message: 'Chat session not found' });
    }
    return session;
  }
}

function toSummary(
  id: string,
  messageCount: number,
  createdAt: Date,
  updatedAt: Date,
  preview?: string,
): ChatSessionSummary {
  // The key is omitted (not `undefined`) when there is no user message yet,
  // so list/history payloads stay free of nullish fields.
  if (preview === undefined) {
    return { id, messageCount, createdAt, updatedAt };
  }
  return { id, messageCount, createdAt, updatedAt, preview };
}

function toStoredMessage(row: {
  id: string;
  role: ChatMessageRole;
  content: string;
  citations: unknown;
  products: unknown;
  createdAt: Date;
}): ChatStoredMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    citations: Array.isArray(row.citations) ? (row.citations as unknown[]) : [],
    products: Array.isArray(row.products) ? (row.products as unknown[]) : [],
    createdAt: row.createdAt,
  };
}
