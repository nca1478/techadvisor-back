import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.js';

describe('Uniform error format (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns { statusCode, code, message } for an unknown route', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/does-not-exist')
      .expect(404)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
        expect(typeof (body as { message: unknown }).message).toBe('string');
      });
  });
});
