import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';

/**
 * Boots the full application for e2e tests with the same production wiring
 * that matters for the contract: global `/api/v1` prefix and the uniform
 * error filter. (Middleware from `AppModule.configure` applies automatically.)
 */
export async function createTestApp(): Promise<{ app: INestApplication; module: TestingModule }> {
  const module: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = module.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return { app, module };
}
