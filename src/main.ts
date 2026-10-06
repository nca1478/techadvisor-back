import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { parseEnv } from './config/env.schema.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';

async function bootstrap() {
  // Fails fast with a legible error when required env vars are missing.
  const config = parseEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix('api/v1');

  // CORS restricted to the configured browser origins.
  app.enableCors({
    origin: config.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  });

  // Uniform error payload `{ statusCode, code, message, details? }` everywhere.
  app.useGlobalFilters(new HttpExceptionFilter());

  // OpenAPI contract for frontend type generation. The JSON document is only
  // registered when DOCS_ENABLED=true (set it to false in production).
  if (config.DOCS_ENABLED) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('TechAdvisor API')
        .setDescription(
          'TechAdvisor ecommerce API. Errors always use the uniform payload { statusCode, code, message, details? }.',
        )
        .setVersion('1.0')
        .build(),
    );
    // With useGlobalPrefix, the UI path 'docs' becomes /api/v1/docs and the
    // JSON document defaults to `{path}-json`, i.e. /api/v1/docs-json.
    SwaggerModule.setup('docs', app, document, {
      useGlobalPrefix: true,
      ui: false,
      raw: ['json'],
    });
  }

  await app.listen(config.PORT);
}

await bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
