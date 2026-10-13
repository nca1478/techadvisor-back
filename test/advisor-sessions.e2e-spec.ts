import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { parseEnv } from '../src/config/env.schema.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { FakeEmbeddingAdapter } from '../src/modules/ai/adapters/fake-embedding.adapter.js';
import { FakeLlmAdapter } from '../src/modules/ai/adapters/fake-llm.adapter.js';
import { EMBEDDING_PROVIDER } from '../src/modules/ai/interfaces/embedding-provider.interface.js';
import { LLM_PROVIDER } from '../src/modules/ai/interfaces/llm-provider.interface.js';
import { EmbeddingStateService } from '../src/modules/reindex/embedding-state.service.js';
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

  // Product-QA fixtures (offline: fake embeddings + scripted LLM, threshold 0
  // so any retrieved evidence answers). One ACTIVE product with an indexed
  // chunk, one ACTIVE product without chunks (abstention path).
  let docProductId = '';
  let emptyProductId = '';
  let brandId = '';
  let categoryId = '';
  const documentIds: string[] = [];

  beforeAll(async () => {
    const fakeEmbeddings = new FakeEmbeddingAdapter({ dimensions: 1536 });
    const fakeLlm = new FakeLlmAdapter({ defaultText: 'La batería dura 10 horas [1].' });
    const ctx = await createTestApp([
      { token: EMBEDDING_PROVIDER, useValue: fakeEmbeddings },
      {
        token: EmbeddingStateService,
        useValue: {
          getScope: () =>
            Promise.resolve({
              model: 'fake-hash-v1',
              dimensions: 1536,
              column: 'embedding',
              cast: 'vector' as const,
              embed: (texts: string[]) => fakeEmbeddings.embed(texts),
            }),
        },
      },
      { token: LLM_PROVIDER, useValue: fakeLlm },
      {
        token: APP_CONFIG,
        useValue: {
          ...parseEnv(),
          // Generous rate budget (one shared IP for the whole file), tight
          // history bounds so the limit paths stay deterministic.
          ADVISOR_RATE_LIMIT_MAX: 1000,
          ADVISOR_ABSTAIN_MIN_SCORE: 0,
          ADVISOR_SESSION_MAX_MESSAGES: 2,
          ADVISOR_MESSAGE_MAX_LENGTH: 50,
        },
      },
    ]);
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const passwords = ctx.module.get(PasswordService);
    const client = prisma as unknown as PrismaClient;

    const brand = await client.brand.create({
      data: { name: `E2E Chat Brand ${suffix}`, slug: `e2e-chat-brand-${suffix}` },
    });
    const category = await client.category.create({
      data: { name: `E2E Chat Cat ${suffix}`, slug: `e2e-chat-cat-${suffix}` },
    });
    brandId = brand.id;
    categoryId = category.id;
    const product = await client.product.create({
      data: {
        sku: `E2E-CHAT-HP-${suffix}`,
        name: `Auriculares Chat ${suffix}`,
        slug: `e2e-chat-hp-${suffix}`,
        description: 'Auriculares para el chat.',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 100_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });
    await client.inventory.create({ data: { productId: product.id, stock: 5, reserved: 0 } });
    const emptyProduct = await client.product.create({
      data: {
        sku: `E2E-CHAT-EMPTY-${suffix}`,
        name: `Vacio Chat ${suffix}`,
        slug: `e2e-chat-empty-${suffix}`,
        description: 'Sin documentos.',
        brandId: brand.id,
        categoryId: category.id,
        priceAmount: 50_00,
        currency: 'USD',
        status: 'ACTIVE',
        specs: {},
      },
    });
    docProductId = product.id;
    emptyProductId = emptyProduct.id;

    const content = 'Estos audífonos tienen una batería que dura hasta 10 horas seguidas.';
    const vectors = await fakeEmbeddings.embed([content]);
    const vector = vectors.at(0);
    if (vector === undefined) {
      throw new Error('Missing fixture vector');
    }
    const doc = await client.document.create({
      data: {
        productId: product.id,
        type: 'SPEC_SHEET',
        title: `E2E chat doc ${suffix}`,
        locale: 'es',
        source: `test:chat-${suffix}`,
        contentHash: `hash-chat-${suffix}`,
        status: 'READY',
      },
    });
    documentIds.push(doc.id);
    const chunk = await client.chunk.create({
      data: {
        documentId: doc.id,
        productId: product.id,
        ord: 0,
        content,
        locale: 'es',
        metadata: { docType: 'SPEC_SHEET' },
        embeddingModel: 'fake-hash-v1',
        embeddingDim: 1536,
      },
    });
    await client.$executeRaw`
      UPDATE "chunks"
      SET "embedding" = ${`[${vector.join(',')}]`}::vector
      WHERE "id" = ${chunk.id}::uuid
    `;

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
    if (docProductId !== '' && emptyProductId !== '') {
      await client.unansweredQuery.deleteMany({
        where: { productId: { in: [docProductId, emptyProductId] } },
      });
    }
    if (documentIds.length > 0) {
      await client.document.deleteMany({ where: { id: { in: documentIds } } });
    }
    if (docProductId !== '' && emptyProductId !== '') {
      await client.product.deleteMany({ where: { id: { in: [docProductId, emptyProductId] } } });
    }
    if (brandId !== '') {
      await client.brand.deleteMany({ where: { id: brandId } });
    }
    if (categoryId !== '') {
      await client.category.deleteMany({ where: { id: categoryId } });
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

    // Listing shows only the caller's own sessions, with the first user
    // message as preview so labels render without fetching each history.
    const listA = await request(server)
      .get('/api/v1/advisor/sessions')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const idsA = (listA.body as SessionBody[]).map((session) => session.id);
    expect(idsA).toContain(sessionA.id);
    const listedA = (listA.body as (SessionBody & { preview?: string })[]).find(
      (session) => session.id === sessionA.id,
    );
    expect(listedA?.preview).toBe('budget 800');

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

  it('physically deletes an owned session with its messages', async () => {
    const server = app.getHttpServer();
    const client = prisma as unknown as PrismaClient;
    const authA = (req: request.Test) => req.set('Authorization', `Bearer ${tokenA}`);
    const authB = (req: request.Test) => req.set('Authorization', `Bearer ${tokenB}`);

    const created = await authA(request(server).post('/api/v1/advisor/sessions')).expect(201);
    const id = (created.body as SessionBody).id;
    createdSessionIds.push(id);
    await authA(
      request(server).post(`/api/v1/advisor/sessions/${id}/messages`).send({
        role: 'USER',
        content: 'bye',
      }),
    ).expect(201);
    await authA(
      request(server).post(`/api/v1/advisor/sessions/${id}/messages`).send({
        role: 'ASSISTANT',
        content: 'bye back',
      }),
    ).expect(201);

    // A foreign user cannot delete: 404 and the session stays intact.
    await authB(request(server).delete(`/api/v1/advisor/sessions/${id}`)).expect(404);
    await authA(request(server).get(`/api/v1/advisor/sessions/${id}`)).expect(200);

    // The owner deletes: history and listing lose it, messages cascade away.
    await authA(request(server).delete(`/api/v1/advisor/sessions/${id}`)).expect(204);
    await authA(request(server).get(`/api/v1/advisor/sessions/${id}`)).expect(404);
    const list = await authA(request(server).get('/api/v1/advisor/sessions')).expect(200);
    expect((list.body as SessionBody[]).map((session) => session.id)).not.toContain(id);
    await expect(client.chatMessage.count({ where: { sessionId: id } })).resolves.toBe(0);

    // Unknown ids 404 like foreign ones; malformed ids 400.
    await authA(
      request(server).delete('/api/v1/advisor/sessions/44444444-4444-4444-8444-444444444444'),
    ).expect(404);
    await authA(request(server).delete('/api/v1/advisor/sessions/not-a-uuid')).expect(400);

    // Guests delete their own sessions too.
    const guest = request.agent(app.getHttpServer());
    const guestCreated = await guest.post('/api/v1/advisor/sessions').expect(201);
    const guestId = (guestCreated.body as SessionBody).id;
    createdSessionIds.push(guestId);
    await guest.delete(`/api/v1/advisor/sessions/${guestId}`).expect(204);
    await guest.get(`/api/v1/advisor/sessions/${guestId}`).expect(404);
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

  it('records answered product-QA turns in the owned session', async () => {
    const server = app.getHttpServer();
    const authA = (req: request.Test) => req.set('Authorization', `Bearer ${tokenA}`);
    const question = '¿Cuánto dura la batería?';

    const created = await authA(request(server).post('/api/v1/advisor/sessions')).expect(201);
    const session = created.body as SessionBody;
    createdSessionIds.push(session.id);

    const res = await authA(
      request(server)
        .post('/api/v1/advisor/product-qa')
        .send({ productId: docProductId, question, locale: 'es', sessionId: session.id }),
    ).expect(200);
    const body = res.body as { answer: string; abstained: boolean; citations: { n: number }[] };
    expect(body.abstained).toBe(false);
    expect(body.citations).toHaveLength(1);

    const history = await authA(
      request(server).get(`/api/v1/advisor/sessions/${session.id}`),
    ).expect(200);
    const historyBody = history.body as HistoryBody;
    expect(historyBody.messageCount).toBe(2);
    expect(historyBody.messages.map((message) => message.role)).toEqual(['USER', 'ASSISTANT']);
    expect(historyBody.messages[0]).toMatchObject({ role: 'USER', content: question });
    expect(historyBody.messages[1]).toMatchObject({
      role: 'ASSISTANT',
      content: body.answer,
      citations: body.citations,
    });
  });

  it('rejects product-QA on a foreign session without answering or recording', async () => {
    const server = app.getHttpServer();
    const client = prisma as unknown as PrismaClient;
    const authA = (req: request.Test) => req.set('Authorization', `Bearer ${tokenA}`);
    const authB = (req: request.Test) => req.set('Authorization', `Bearer ${tokenB}`);

    const created = await authA(request(server).post('/api/v1/advisor/sessions')).expect(201);
    const session = created.body as SessionBody;
    createdSessionIds.push(session.id);

    await authB(
      request(server).post('/api/v1/advisor/product-qa').send({
        productId: docProductId,
        question: '¿Cuánto dura la batería?',
        sessionId: session.id,
      }),
    ).expect(404);

    // Nothing was recorded: the session is still empty and no abstention row exists.
    const history = await authA(
      request(server).get(`/api/v1/advisor/sessions/${session.id}`),
    ).expect(200);
    expect((history.body as HistoryBody).messageCount).toBe(0);
    const rows = await client.unansweredQuery.findMany({ where: { sessionId: session.id } });
    expect(rows).toEqual([]);
  });

  it('records the user turn and session id on abstentions', async () => {
    const server = app.getHttpServer();
    const client = prisma as unknown as PrismaClient;
    const authA = (req: request.Test) => req.set('Authorization', `Bearer ${tokenA}`);
    const question = '¿Este producto sin docs tiene bluetooth?';

    const created = await authA(request(server).post('/api/v1/advisor/sessions')).expect(201);
    const session = created.body as SessionBody;
    createdSessionIds.push(session.id);

    const res = await authA(
      request(server)
        .post('/api/v1/advisor/product-qa')
        .send({ productId: emptyProductId, question, locale: 'es', sessionId: session.id }),
    ).expect(200);
    expect((res.body as { abstained: boolean }).abstained).toBe(true);

    const history = await authA(
      request(server).get(`/api/v1/advisor/sessions/${session.id}`),
    ).expect(200);
    const historyBody = history.body as HistoryBody;
    expect(historyBody.messageCount).toBe(1);
    expect(historyBody.messages[0]).toMatchObject({ role: 'USER', content: question });

    const rows = await client.unansweredQuery.findMany({ where: { sessionId: session.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ query: question, productId: emptyProductId });
  });

  it('keeps abstentions without a session linked to no session', async () => {
    const server = app.getHttpServer();
    const client = prisma as unknown as PrismaClient;
    const authA = (req: request.Test) => req.set('Authorization', `Bearer ${tokenA}`);
    const question = `Sin sesión ${suffix}`;

    await authA(
      request(server)
        .post('/api/v1/advisor/product-qa')
        .send({ productId: emptyProductId, question }),
    ).expect(200);

    const rows = await client.unansweredQuery.findMany({ where: { query: question } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBeNull();
  });

  it('rejects product-QA once the session history is full', async () => {
    const server = app.getHttpServer();
    const authA = (req: request.Test) => req.set('Authorization', `Bearer ${tokenA}`);

    // This suite caps sessions at 2 messages: one answered turn fills it.
    const created = await authA(request(server).post('/api/v1/advisor/sessions')).expect(201);
    const session = created.body as SessionBody;
    createdSessionIds.push(session.id);
    await authA(
      request(server).post('/api/v1/advisor/product-qa').send({
        productId: docProductId,
        question: '¿Cuánto dura la batería?',
        sessionId: session.id,
      }),
    ).expect(200);

    await authA(
      request(server)
        .post('/api/v1/advisor/product-qa')
        .send({ productId: docProductId, question: '¿Otra pregunta?', sessionId: session.id }),
    ).expect(400);
  });

  it('validates the sessionId shape on product-QA', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/v1/advisor/product-qa')
      .send({ productId: docProductId, question: '¿Cuánto dura la batería?', sessionId: 'no-uuid' })
      .expect(400);
  });
});
