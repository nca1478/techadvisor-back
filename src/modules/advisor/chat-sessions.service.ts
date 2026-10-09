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
    return rows.map((row) => toSummary(row.id, row._count.messages, row.createdAt, row.updatedAt));
  }

  /** Reads one session with its full history (oldest message first). */
  async getSessionHistory(sessionId: string, owner: ChatSessionOwner): Promise<ChatSessionHistory> {
    const session = await this.findOwnedSessionOrThrow(sessionId, owner);
    const messages = await this.prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });
    return {
      ...toSummary(session.id, messages.length, session.createdAt, session.updatedAt),
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
): ChatSessionSummary {
  return { id, messageCount, createdAt, updatedAt };
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
