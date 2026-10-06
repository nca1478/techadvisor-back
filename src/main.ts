import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { parseEnv } from './config/env.schema.js';

async function bootstrap() {
  // Fails fast with a legible error when required env vars are missing.
  const config = parseEnv();
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  await app.listen(config.PORT);
}

await bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
