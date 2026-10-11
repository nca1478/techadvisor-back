import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './test-app.js';

/**
 * Admin advisor improvement loop (e2e, see ADR 0040).
 *
 * - Every `/admin/advisor/*` route requires ADMIN (401 without token, 403
 *   for CUSTOMER).
 * - Flows: abstention triage NEW → IN_REVIEW → RESOLVED (forward-only),
 *   frequency groups over near-duplicate questions, minimized feedback
 *   lists with an explicit full-content detail, minimized session links,
 *   and the metrics summary (abstention, satisfaction, frequent gaps).
 *
 * Fixtures are prefixed with a run-unique marker and removed in `afterAll`,
 * so the suite never mutates pre-existing rows.
 */

const PASSWORD = 'long-enough-password';

describe('Admin advisor panel (e2e)', () => {
  const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;
  const marker = `e2e-adv-${suffix}`;
  let app: INestApplication;
  let prisma: PrismaService;
  const createdUserIds: string[] = [];
  const unansweredIds: string[] = [];
  const feedbackIds: string[] = [];
  const sessionIds: string[] = [];
  let adminToken = '';
  let customerToken = '';
  let groupQuestionA = '';
  let groupQuestionB = '';
  let sessionWithHistory = '';

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    prisma = ctx.module.get(PrismaService);
    const passwords = ctx.module.get(PasswordService);
    const client = prisma as unknown as PrismaClient;

    const adminEmail = `${marker}-admin@example.com`;
    const admin = await prisma.user.create({
      data: { email: adminEmail, passwordHash: await passwords.hash(PASSWORD), role: 'ADMIN' },
      select: { id: true },
    });
    createdUserIds.push(admin.id);
    const adminLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: PASSWORD })
      .expect(200);
    adminToken = (adminLogin.body as { tokens: { accessToken: string } }).tokens.accessToken;

    const customerEmail = `${marker}-customer@example.com`;
    const customer = await prisma.user.create({
      data: {
        email: customerEmail,
        passwordHash: await passwords.hash(PASSWORD),
        role: 'CUSTOMER',
      },
      select: { id: true },
    });
    createdUserIds.push(customer.id);
    const customerLogin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: customerEmail, password: PASSWORD })
      .expect(200);
    customerToken = (customerLogin.body as { tokens: { accessToken: string } }).tokens.accessToken;

    // Owned session with history for the minimized conversation link.
    const session = await client.chatSession.create({ data: { userId: customer.id } });
    sessionIds.push(session.id);
    sessionWithHistory = session.id;
    await client.chatMessage.create({
      data: { sessionId: session.id, role: 'USER', content: `${marker} bateria?`.padEnd(250, '!') },
    });
    await client.chatMessage.create({
      data: { sessionId: session.id, role: 'ASSISTANT', content: 'Respuesta breve.' },
    });

    // Near-duplicate abstentions for the frequency groups.
    groupQuestionA = `${marker} ¿Cuanto dura la bateria?`;
    groupQuestionB = `${marker} CUÁNTO DURA... ¡la batería!`;
    for (const [question, reason] of [
      [groupQuestionA, 'no_evidence'],
      [groupQuestionB, 'no_evidence'],
      [`${marker} ¿Tiene garantia extendida?`, 'below_threshold'],
    ] as Array<[string, string]>) {
      const created = await client.unansweredQuery.create({
        data: { query: question, reason, sessionId: session.id },
      });
      unansweredIds.push(created.id);
    }

    for (const [value, abstained] of [
      ['up', false],
      ['down', true],
    ] as Array<['up' | 'down', boolean]>) {
      const created = await client.advisorFeedback.create({
        data: {
          query: `${marker} pregunta ${value}`,
          answer: `${marker} respuesta ${value} `.padEnd(600, '.'),
          abstained,
          value,
          sessionId: session.id,
        },
      });
      feedbackIds.push(created.id);
    }
  }, 60_000);

  afterAll(async () => {
    const client = prisma as unknown as PrismaClient;
    if (unansweredIds.length > 0) {
      await client.unansweredQuery.deleteMany({ where: { id: { in: unansweredIds } } });
    }
    if (feedbackIds.length > 0) {
      await client.advisorFeedback.deleteMany({ where: { id: { in: feedbackIds } } });
    }
    if (sessionIds.length > 0) {
      await client.chatSession.deleteMany({ where: { id: { in: sessionIds } } });
    }
    if (createdUserIds.length > 0) {
      await client.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('rejects anonymous and CUSTOMER tokens on every route', async () => {
    const server = app.getHttpServer();
    const target = unansweredIds[0] ?? '00000000-0000-4000-8000-000000000000';
    const routes: Array<[string, string]> = [
      ['get', '/api/v1/admin/advisor/unanswered'],
      ['get', '/api/v1/admin/advisor/unanswered/groups'],
      ['patch', `/api/v1/admin/advisor/unanswered/${target}`],
      ['get', '/api/v1/admin/advisor/feedback'],
      ['get', `/api/v1/admin/advisor/feedback/${target}`],
      ['get', `/api/v1/admin/advisor/sessions/${target}`],
      ['get', '/api/v1/admin/advisor/metrics'],
    ];
    for (const [method, path] of routes) {
      const anonymous =
        method === 'get'
          ? request(server).get(path)
          : request(server).patch(path).send({ status: 'IN_REVIEW' });
      await anonymous.expect(401);
      const customer =
        method === 'get'
          ? request(server).get(path).set('Authorization', `Bearer ${customerToken}`)
          : request(server)
              .patch(path)
              .set('Authorization', `Bearer ${customerToken}`)
              .send({ status: 'IN_REVIEW' });
      await customer.expect(403);
    }
  });

  it('lists abstentions with status filter and pagination', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/advisor/unanswered?status=NEW&q=${encodeURIComponent(marker)}&limit=10`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as { data: { query: string; status: string }[]; total: number };
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.data.every((row) => row.status === 'NEW')).toBe(true);
    expect(body.data.every((row) => row.query.includes(marker))).toBe(true);
  });

  it('groups near-duplicate abstentions by frequency', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/advisor/unanswered/groups?scanLimit=500&limit=10`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      data: { key: string; sample: string; count: number; ids: string[] }[];
    };
    // Same normalization as the backend bucketing (dashes fold to spaces);
    // only this run's fixtures carry the marker prefix.
    const markerKey = marker.toLowerCase().replace(/-/g, ' ');
    const own = body.data.filter((group) => group.key.startsWith(markerKey));
    expect(own).toHaveLength(2);
    const bucket = own.find((group) => group.count === 2);
    expect(bucket).toBeDefined();
    expect(bucket?.sample).toContain(marker);
    expect(bucket?.ids).toHaveLength(2);
  });

  it('moves an abstention forward to RESOLVED and rejects reopening', async () => {
    const server = app.getHttpServer();
    const id = unansweredIds[0] ?? '';
    const reviewing = await request(server)
      .patch(`/api/v1/admin/advisor/unanswered/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'IN_REVIEW' })
      .expect(200);
    expect((reviewing.body as { status: string }).status).toBe('IN_REVIEW');

    const resolved = await request(server)
      .patch(`/api/v1/admin/advisor/unanswered/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'RESOLVED' })
      .expect(200);
    expect((resolved.body as { status: string }).status).toBe('RESOLVED');

    await request(server)
      .patch(`/api/v1/admin/advisor/unanswered/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'NEW' })
      .expect(400);
    await request(server)
      .patch('/api/v1/admin/advisor/unanswered/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'IN_REVIEW' })
      .expect(404);
  });

  it('lists feedback minimized and exposes full content only on detail', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/advisor/feedback?value=down')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listBody = list.body as {
      data: Record<string, unknown>[];
      total: number;
    };
    expect(listBody.total).toBeGreaterThanOrEqual(1);
    expect(listBody.data[0]).not.toHaveProperty('query');
    expect(listBody.data[0]).not.toHaveProperty('answer');
    expect(listBody.data[0]).toHaveProperty('queryExcerpt');
    expect(listBody.data[0]).toHaveProperty('answerExcerpt');
    // Votes carry their session so the panel can link the conversation.
    expect(listBody.data[0]?.['sessionId']).toBe(sessionWithHistory);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/advisor/feedback/${feedbackIds[0] ?? ''}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((detail.body as { query: string }).query).toContain(marker);
    expect((detail.body as { sessionId: string }).sessionId).toBe(sessionWithHistory);
    await request(app.getHttpServer())
      .get('/api/v1/admin/advisor/feedback/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('links the conversation minimized, without full message content', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/advisor/sessions/${sessionWithHistory}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      sessionId: string;
      messageCount: number;
      messages: { role: string; excerpt: string; length: number }[];
    };
    expect(body.messageCount).toBe(2);
    expect(body.messages[0]?.length).toBeGreaterThan(200);
    expect(body.messages[0]?.excerpt.length).toBeLessThanOrEqual(201);
    expect(body).not.toHaveProperty('content');
    await request(app.getHttpServer())
      .get('/api/v1/admin/advisor/sessions/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('summarizes abstention, satisfaction and frequent gaps', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/advisor/metrics')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      openUnanswered: number;
      unansweredByStatus: { key: string; count: number }[];
      unansweredByReason: { key: string; count: number }[];
      feedbackTotal: number;
      feedbackUp: number;
      feedbackDown: number;
      satisfactionRate: number | null;
      topQueries: { key: string; sample: string; count: number }[];
    };
    expect(typeof body.openUnanswered).toBe('number');
    expect(Array.isArray(body.unansweredByStatus)).toBe(true);
    expect(Array.isArray(body.unansweredByReason)).toBe(true);
    expect(body.feedbackTotal).toBeGreaterThanOrEqual(2);
    expect(typeof body.satisfactionRate).toBe('number');
    expect(Array.isArray(body.topQueries)).toBe(true);
    expect(body.topQueries.length).toBeLessThanOrEqual(10);
  });
});
