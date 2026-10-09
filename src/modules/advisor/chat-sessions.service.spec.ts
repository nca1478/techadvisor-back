import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/env.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { ChatSessionsService, type ChatSessionOwner } from './chat-sessions.service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ANON_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANON_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const CONFIG = {
  ADVISOR_SESSION_MAX_MESSAGES: 2,
  ADVISOR_MESSAGE_MAX_LENGTH: 10,
  ADVISOR_ANON_SESSION_RETENTION_DAYS: 30,
} as unknown as AppConfig;

const USER_OWNER: ChatSessionOwner = { kind: 'user', userId: USER_A };
const GUEST_OWNER: ChatSessionOwner = { kind: 'guest', anonSessionId: ANON_A };

function userSessionRow() {
  return {
    id: SESSION_ID,
    userId: USER_A,
    anonSessionId: null,
    createdAt: new Date('2026-10-09T10:00:00.000Z'),
    updatedAt: new Date('2026-10-09T10:00:00.000Z'),
  };
}

function guestSessionRow() {
  return {
    id: SESSION_ID,
    userId: null,
    anonSessionId: ANON_A,
    createdAt: new Date('2026-10-09T10:00:00.000Z'),
    updatedAt: new Date('2026-10-09T10:00:00.000Z'),
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    sessionId: SESSION_ID,
    role: 'USER',
    content: 'hi',
    citations: [],
    products: [],
    createdAt: new Date('2026-10-09T10:01:00.000Z'),
    updatedAt: new Date('2026-10-09T10:01:00.000Z'),
    ...overrides,
  };
}

interface SessionMocks {
  sessionCreate: ReturnType<typeof vi.fn>;
  sessionFindMany: ReturnType<typeof vi.fn>;
  sessionFindUnique: ReturnType<typeof vi.fn>;
  sessionDeleteMany: ReturnType<typeof vi.fn>;
  messageFindMany: ReturnType<typeof vi.fn>;
  messageCount: ReturnType<typeof vi.fn>;
  messageCreate: ReturnType<typeof vi.fn>;
}

function buildService(overrides: Partial<SessionMocks> = {}) {
  const mocks: SessionMocks = {
    sessionCreate: vi.fn(),
    sessionFindMany: vi.fn().mockResolvedValue([]),
    sessionFindUnique: vi.fn(),
    sessionDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    messageFindMany: vi.fn().mockResolvedValue([]),
    messageCount: vi.fn().mockResolvedValue(0),
    messageCreate: vi.fn(),
    ...overrides,
  };
  const prisma = {
    chatSession: {
      create: mocks.sessionCreate,
      findMany: mocks.sessionFindMany,
      findUnique: mocks.sessionFindUnique,
      deleteMany: mocks.sessionDeleteMany,
    },
    chatMessage: {
      findMany: mocks.messageFindMany,
      count: mocks.messageCount,
      create: mocks.messageCreate,
    },
  } as unknown as PrismaService;
  const service = new ChatSessionsService(prisma, CONFIG);
  return { service, mocks };
}

describe('ChatSessionsService (unit, mocked database)', () => {
  it('creates user sessions with userId and guest sessions with anonSessionId', async () => {
    const sessionCreate = vi
      .fn()
      .mockResolvedValueOnce({ ...userSessionRow(), _count: { messages: 0 } })
      .mockResolvedValueOnce({ ...guestSessionRow(), _count: { messages: 0 } });
    const { service } = buildService({ sessionCreate });

    const userSession = await service.createSession(USER_OWNER);
    expect(sessionCreate).toHaveBeenNthCalledWith(1, {
      data: { userId: USER_A },
      include: { _count: { select: { messages: true } } },
    });
    expect(userSession).toMatchObject({ id: SESSION_ID, messageCount: 0 });

    await service.createSession(GUEST_OWNER);
    expect(sessionCreate).toHaveBeenNthCalledWith(2, {
      data: { anonSessionId: ANON_A },
      include: { _count: { select: { messages: true } } },
    });
  });

  it('reads history for the owner with messages oldest-first', async () => {
    const { service } = buildService({
      sessionFindUnique: vi.fn().mockResolvedValue(userSessionRow()),
      messageFindMany: vi
        .fn()
        .mockResolvedValue([messageRow({ content: 'first' }), messageRow({ content: 'second' })]),
    });

    const history = await service.getSessionHistory(SESSION_ID, USER_OWNER);
    expect(history).toMatchObject({ id: SESSION_ID, messageCount: 2 });
    expect(history.messages.map((message) => message.content)).toEqual(['first', 'second']);
  });

  it.each([
    ['unknown id', null, USER_OWNER],
    ['user session read as guest', userSessionRow(), GUEST_OWNER],
    ['user session read by another user', userSessionRow(), { kind: 'user', userId: USER_B }],
    ['guest session read as user', guestSessionRow(), USER_OWNER],
    [
      'guest session read by another guest',
      guestSessionRow(),
      { kind: 'guest', anonSessionId: ANON_B },
    ],
  ])('404s on %s (never reveals ownership)', async (_label, row, owner) => {
    const { service } = buildService({
      sessionFindUnique: vi.fn().mockResolvedValue(row),
    });

    await expect(
      service.getSessionHistory(SESSION_ID, owner as ChatSessionOwner),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects cross-user message appends like unknown ids', async () => {
    const messageCreate = vi.fn();
    const { service } = buildService({
      sessionFindUnique: vi.fn().mockResolvedValue(userSessionRow()),
      messageCreate,
    });

    await expect(
      service.addMessage(
        SESSION_ID,
        { kind: 'user', userId: USER_B },
        { role: 'USER', content: 'hi' },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it('rejects messages longer than ADVISOR_MESSAGE_MAX_LENGTH', async () => {
    const messageCreate = vi.fn();
    const { service } = buildService({
      sessionFindUnique: vi.fn().mockResolvedValue(userSessionRow()),
      messageCreate,
    });

    await expect(
      service.addMessage(SESSION_ID, USER_OWNER, { role: 'USER', content: 'x'.repeat(11) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it('rejects appends once the session holds ADVISOR_SESSION_MAX_MESSAGES', async () => {
    const messageCreate = vi.fn();
    const { service } = buildService({
      sessionFindUnique: vi.fn().mockResolvedValue(userSessionRow()),
      messageCount: vi.fn().mockResolvedValue(2),
      messageCreate,
    });

    await expect(
      service.addMessage(SESSION_ID, USER_OWNER, { role: 'USER', content: 'hi' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it('appends a message within both limits', async () => {
    const messageCreate = vi
      .fn()
      .mockResolvedValue(
        messageRow({
          role: 'ASSISTANT',
          content: 'hi',
          citations: [{ n: 1 }],
          products: [{ id: 'p1' }],
        }),
      );
    const { service } = buildService({
      sessionFindUnique: vi.fn().mockResolvedValue(guestSessionRow()),
      messageCount: vi.fn().mockResolvedValue(1),
      messageCreate,
    });

    const stored = await service.addMessage(SESSION_ID, GUEST_OWNER, {
      role: 'ASSISTANT',
      content: 'hi',
      citations: [{ n: 1 }],
      products: [{ id: 'p1' }],
    });
    expect(messageCreate).toHaveBeenCalledWith({
      data: {
        sessionId: SESSION_ID,
        role: 'ASSISTANT',
        content: 'hi',
        citations: [{ n: 1 }],
        products: [{ id: 'p1' }],
      },
    });
    expect(stored).toMatchObject({ role: 'ASSISTANT', content: 'hi' });
    expect(stored.citations).toEqual([{ n: 1 }]);
  });

  it('lists user sessions newest-first via the database ordering', async () => {
    const sessionFindMany = vi.fn().mockResolvedValue([
      { ...userSessionRow(), _count: { messages: 2 } },
      { ...userSessionRow(), id: 'other-id', _count: { messages: 0 } },
    ]);
    const { service } = buildService({ sessionFindMany });

    const listed = await service.listUserSessions(USER_A);
    expect(sessionFindMany).toHaveBeenCalledWith({
      where: { userId: USER_A },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { messages: true } } },
    });
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ id: SESSION_ID, messageCount: 2 });
  });

  it('purges only anonymous sessions older than the retention window', async () => {
    const sessionDeleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const { service } = buildService({ sessionDeleteMany });

    const now = new Date('2026-10-09T12:00:00.000Z');
    const result = await service.cleanupExpiredAnonymousSessions(now);
    expect(result).toEqual({ deleted: 3 });
    const expectedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { userId: null, createdAt: { lt: expectedCutoff } },
    });
  });
});
