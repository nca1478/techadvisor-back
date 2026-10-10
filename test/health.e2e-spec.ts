import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.js';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns extended probe without live AI calls', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', db: 'up' });
    // Extended probe (see ADR 0039): redis + ingestion queue + last-known AI
    // state. No value may carry user content — only closed enums.
    expect(['up', 'down']).toContain(body.redis);
    expect(['up', 'down', 'unknown']).toContain(body.ingestion);
    expect(['up', 'degraded', 'unknown']).toContain(body.ai);
  });

  it('responds with a request id header', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect('x-request-id', /.+/);
  });
});
