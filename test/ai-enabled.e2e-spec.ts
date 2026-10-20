import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { parseEnv } from '../src/config/env.schema.js';
import { createTestApp } from './test-app.js';

/**
 * Storefront AI kill-switch (see ADR 0079).
 *
 * Boots the full app with `AI_ENABLED=false` (overriding only `APP_CONFIG`;
 * no fixtures needed because the guard runs before validation and services)
 * and pins the two sides of the contract: the public advisor surface answers
 * `403 FORBIDDEN`, and `GET /config/public` reports `aiEnabled: false` so
 * the frontend hides the UI.
 */
describe('AI kill-switch (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp([
      { token: APP_CONFIG, useValue: { ...parseEnv(), AI_ENABLED: false } },
    ]));
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['POST', '/api/v1/advisor/product-qa'],
    ['POST', '/api/v1/advisor/compare'],
    ['POST', '/api/v1/advisor/support'],
    ['POST', '/api/v1/advisor/feedback'],
    ['POST', '/api/v1/advisor/sessions'],
  ])('%s %s answers 403 while AI is disabled', async (method, url) => {
    const req = method === 'POST' ? request(app.getHttpServer()).post(url).send({}) : null;
    await req?.expect(403).expect(({ body }: { body: unknown }) => {
      expect(body).toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'AI features are disabled',
      });
    });
  });

  it('GET /api/v1/config/public reports aiEnabled: false', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/config/public')
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({ aiEnabled: false });
      });
  });
});
