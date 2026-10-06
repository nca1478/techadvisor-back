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

  it('GET /api/v1/health returns { status: ok, db: up }', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({ status: 'ok', db: 'up' });
      });
  });

  it('responds with a request id header', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect('x-request-id', /.+/);
  });
});
