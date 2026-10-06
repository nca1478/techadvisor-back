import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';

/**
 * Boots the full application for e2e tests with the same production wiring
 * that matters for the contract: global `/api/v1` prefix and the uniform
 * error filter. (Middleware from `AppModule.configure` applies automatically.)
 *
 * `overrides` replaces providers (e.g. the payment provider with a fake) so
 * suites can run without external credentials. `rawBody: true` mirrors
 * `main.ts` so webhook signature tests see the exact request bytes.
 */
export async function createTestApp(
  overrides: { token: symbol | string | object; useValue: unknown }[] = [],
): Promise<{ app: INestApplication; module: TestingModule }> {
  let builder = Test.createTestingModule({
    imports: [AppModule],
  });
  for (const override of overrides) {
    builder = builder.overrideProvider(override.token).useValue(override.useValue);
  }
  const module: TestingModule = await builder.compile();

  const app = module.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return { app, module };
}
