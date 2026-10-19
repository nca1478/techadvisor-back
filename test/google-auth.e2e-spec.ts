import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.js';

/**
 * Google sign-in endpoint (see ADR 0077). No Google credentials are used
 * here: with no GOOGLE_CLIENT_ID (or an invalid token) the endpoint must
 * answer 401 without revealing details; a missing body must answer 400.
 */
describe('POST /auth/google (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('400 when idToken is missing', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/google')
      .send({})
      .expect(400)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ statusCode: 400 });
      });
  });

  it('401 for an invalid Google credential (no user enumeration)', async () => {
    for (const payload of [{ idToken: 'invalid-token' }, { accessToken: 'invalid-token' }]) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/google')
        .send(payload)
        .expect(401)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
        });
    }
  });
});
