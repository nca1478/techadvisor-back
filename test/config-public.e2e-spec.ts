import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.js';

describe('Public config (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/config/public returns the configured currencies and locales', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/config/public')
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toEqual({
          baseCurrency: 'USD',
          supportedCurrencies: ['USD', 'EUR'],
          defaultLocale: 'en',
          supportedLocales: ['en', 'es'],
          aiEnabled: true,
        });
      });
  });
});
