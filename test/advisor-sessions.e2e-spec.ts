import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { parseEnv } from '../src/config/env.schema.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { createTestApp } from './test-app.js';

/**
 * Advisor chat-session history (e2e, see ADR 0029).
 *
 * Covers the acceptance criteria: a session is created, its history is read
 * back, and cross-user access is rejected — for anonymous guests (signed
 * `sid` cookie, one `request.agent` per guest) and authenticated users alike
 * — plus the configured history limits and the admin retention cleanup.
 * Message content is never asserted in logs; only API shapes are checked.
 */

const PASSWORD = 'long-enough-password';

interface SessionBody {
  id: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface HistoryBody extends SessionBody {
  messages: {
    id: string;
    role: 'USER' | 'ASSISTANT';
    content: string;
    citations: unknown[];
    products: unknown[];
    createdAt: string;
  }[];
}

describe('Advisor chat sessions (e2e)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  let app: INestApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];
  const createdSessionIds: string[] = [];

  let tokenA = '';
  let tokenB = '';
  let adminToken = '';

  async function register(email: string): Promise<{ userId: string; token: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD })
      .expect(201);
    const body = res.body as { user: { id: string }; tokens: { accessToken: string } };
    createdUserIds.push(body.user.id);
    return { userId: body.user.id, token: body.tokens.accessToken };
  }

  beforeAll(async () => {
    const ctx = await createTestApp([
      {
        token: APP_CONFIG,
        useValue: {
          ...parseEnv(),
          // Generous rate budget (one shared IP for the whole file), tight
          // history bounds so the limit paths stay deterministic.
          ADVISOR_RATE_LIMIT_MAX: 1000,
          ADVISOR_SESSION_MAX_MESSAGES: 2,
          ADVISOR_MESSAGE_MAX_LENGTH: 50,
        },
      },
    ]);
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const passwords = ctx.module.get(PasswordService);

    const adminEmail = `e2e-chat-admin-${suffix}@example.com`;
    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await passwords.hash(PASSWORD),
        role: 'ADMIN',
      },
      select: { id: true },
    });
    createdUserIds.push(admin.id);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: PASSWORD })
      .expect(200);
    adminToken = (login.body as { tokens: { accessToken: string } }).tokens.accessToken;

    ({ token: tokenA } = await register(`e2e-chat-a-${suffix}@example.com`));
    ({ token: tokenB } = await register(`e2e-chat-b-${suffix}@example.com`));
  }, 60_000);

  afterAll(async () => {
    const client = prisma as unknown as PrismaClient;
    if (createdSessionIds.length > 0) {
      await client.chatMessage.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
      await client.chatSession.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('creates an anonymous session (issuing sid), appends, and reads history', async () => {
    const guest = request.agent(app.getHttpServer());

    const created = await guest.post('/api/v1/advisor/sessions').expect(201);
    const session = created.body as SessionBody;
    expect(typeof session.id).toBe('string');
    expect(session.messageCount).toBe(0);
    createdSessionIds.push(session.id);
    const setCookie = created.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie?.join(';')).toMatch(/sid=[^;]+;.*HttpOnly/i);

    await guest
      .post(`/api/v1/advisor/sessions/${session.id}/messages`)
      .send({ role: 'USER', content: 'hello' })
      .expect(201)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ role: 'USER', content: 'hello' });
      });

    const history = await guest.get(`/api/v1/advisor/sessions/${session.id}`).expect(200);
    const body = history.body as HistoryBody;
    expect(body).toMatchObject({ id: session.id, messageCount: 1 });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      role: 'USER',
      content: 'hello',
      citations: [],
      products: [],
    });
  });

  it('rejects cross-guest access: another sid reads the session as unknown', async () => {
    const guest = request.agent(app.getHttpServer());
    const other = request.agent(app.getHttpServer());

    const created = await guest.post('/api/v1/advisor/sessions').expect(201);
    const session = created.body as SessionBody;
    createdSessionIds.push(session.id);

    await other.get(`/api/v1/advisor/sessions/${session.id}`).expect(404);
    await other
      .post(`/api/v1/advisor/sessions/${session.id}/messages`)
      .send({ role: 'USER', content: 'intruder' })
      .expect(404);
  });

  it('creates user sessions, isolates them per user, and lists only own', async () => {
    const server = app.getHttpServer();

    const createdA = await request(server)
      .post('/api/v1/advisor/sessions')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(201);
    const sessionA = createdA.body as SessionBody;
    createdSessionIds.push(sessionA.id);

    await request(server)
      .post(`/api/v1/advisor/sessions/${sessionA.id}/messages`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ role: 'USER', content: 'budget 800' })
      .expect(201);
    await request(server)
      .post(`/api/v1/advisor/sessions/${sessionA.id}/messages`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ role: 'ASSISTANT', content: 'top pick', citations: [{ n: 1 }] })
      .expect(201);

    // Owner reads the full history, oldest first.
    const history = await request(server)
      .get(`/api/v1/advisor/sessions/${sessionA.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const body = history.body as HistoryBody;
    expect(body.messageCount).toBe(2);
    expect(body.messages.map((message) => message.role)).toEqual(['USER', 'ASSISTANT']);
    expect(body.messages[1]?.citations).toEqual([{ n: 1 }]);

    // Another authenticated user sees it as unknown (read and write).
    await request(server)
      .get(`/api/v1/advisor/sessions/${sessionA.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
    await request(server)
      .post(`/api/v1/advisor/sessions/${sessionA.id}/messages`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ role: 'USER', content: 'intruder' })
      .expect(404);

    // Listing shows only the caller's own sessions.
    const listA = await request(server)
      .get('/api/v1/advisor/sessions')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const idsA = (listA.body as SessionBody[]).map((session) => session.id);
    expect(idsA).toContain(sessionA.id);

    const listB = await request(server)
      .get('/api/v1/advisor/sessions')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(listB.body as SessionBody[]).toEqual([]);

    // Anonymous callers cannot list; unknown ids 404 like foreign ones.
    await request(server).get('/api/v1/advisor/sessions').expect(401);
    await request(server)
      .get('/api/v1/advisor/sessions/44444444-4444-4444-8444-444444444444')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  });

  it('never mixes user and guest ownership', async () => {
    const server = app.getHttpServer();
    const guest = request.agent(app.getHttpServer());

    const created = await guest.post('/api/v1/advisor/sessions').expect(201);
    const anonSession = created.body as SessionBody;
    createdSessionIds.push(anonSession.id);

    // An authenticated user cannot read an anonymous session, even its own cookie jar.
    await request(server)
      .get(`/api/v1/advisor/sessions/${anonSession.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    // A guest cookie cannot read a user session either.
    const userCreated = await request(server)
      .post('/api/v1/advisor/sessions')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(201);
    createdSessionIds.push((userCreated.body as SessionBody).id);
    await guest.get(`/api/v1/advisor/sessions/${(userCreated.body as SessionBody).id}`).expect(404);
  });

  it('validates session id, role and content shape', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/v1/advisor/sessions/not-a-uuid').expect(400);

    const created = await request(server)
      .post('/api/v1/advisor/sessions')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(201);
    createdSessionIds.push((created.body as SessionBody).id);
    const id = (created.body as SessionBody).id;
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${tokenA}`);

    await auth(
      request(server).post(`/api/v1/advisor/sessions/${id}/messages`).send({
        role: 'USER',
        content: '   ',
      }),
    ).expect(400);
    await auth(
      request(server).post(`/api/v1/advisor/sessions/${id}/messages`).send({
        role: 'BOT',
        content: 'hello',
      }),
    ).expect(400);
    await auth(
      request(server).post(`/api/v1/advisor/sessions/${id}/messages`).send({ role: 'USER' }),
    ).expect(400);
  });

  it('enforces the configured per-message length and per-session count', async () => {
    const server = app.getHttpServer();
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${tokenA}`);

    const created = await auth(request(server).post('/api/v1/advisor/sessions')).expect(201);
    const id = (created.body as SessionBody).id;
    createdSessionIds.push(id);

    // Over ADVISOR_MESSAGE_MAX_LENGTH (50 in this suite).
    await auth(
      request(server)
        .post(`/api/v1/advisor/sessions/${id}/messages`)
        .send({
          role: 'USER',
          content: 'x'.repeat(51),
        }),
    ).expect(400);

    // Up to ADVISOR_SESSION_MAX_MESSAGES (2 in this suite), then rejected.
    await auth(
      request(server).post(`/api/v1/advisor/sessions/${id}/messages`).send({
        role: 'USER',
        content: 'first',
      }),
    ).expect(201);
    await auth(
      request(server).post(`/api/v1/advisor/sessions/${id}/messages`).send({
        role: 'USER',
        content: 'second',
      }),
    ).expect(201);
    await auth(
      request(server).post(`/api/v1/advisor/sessions/${id}/messages`).send({
        role: 'USER',
        content: 'third',
      }),
    ).expect(400);
  });

  it('admin cleanup purges only expired anonymous sessions', async () => {
    const server = app.getHttpServer();
    const client = prisma as unknown as PrismaClient;

    const oldGuest = request.agent(app.getHttpServer());
    const freshGuest = request.agent(app.getHttpServer());
    const oldAnon = (await oldGuest.post('/api/v1/advisor/sessions').expect(201))
      .body as SessionBody;
    const freshAnon = (await freshGuest.post('/api/v1/advisor/sessions').expect(201))
      .body as SessionBody;
    const oldUser = (
      await request(server)
        .post('/api/v1/advisor/sessions')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(201)
    ).body as SessionBody;
    createdSessionIds.push(oldAnon.id, freshAnon.id, oldUser.id);

    // Age two sessions past the 30-day retention window (raw SQL: the API has
    // no backdating path by design).
    await client.$executeRaw`UPDATE "chat_sessions" SET "created_at" = NOW() - INTERVAL '31 days' WHERE "id" = ${oldAnon.id}::uuid`;
    await client.$executeRaw`UPDATE "chat_sessions" SET "created_at" = NOW() - INTERVAL '60 days' WHERE "id" = ${oldUser.id}::uuid`;

    // Non-admins cannot trigger the purge.
    await request(server).post('/api/v1/advisor/sessions/cleanup').expect(401);
    await request(server)
      .post('/api/v1/advisor/sessions/cleanup')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(403);

    const res = await request(server)
      .post('/api/v1/advisor/sessions/cleanup')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((res.body as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);

    // Expired anonymous session is gone; fresh anonymous and old user sessions survive.
    await oldGuest.get(`/api/v1/advisor/sessions/${oldAnon.id}`).expect(404);
    await freshGuest.get(`/api/v1/advisor/sessions/${freshAnon.id}`).expect(200);
    await request(server)
      .get(`/api/v1/advisor/sessions/${oldUser.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
  });
});
