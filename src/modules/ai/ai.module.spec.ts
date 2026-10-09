import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { APP_CONFIG, AppConfigModule } from '../../config/app-config.module.js';
import { parseEnv } from '../../config/env.schema.js';
import { AiModule } from './ai.module.js';
import { EMBEDDING_PROVIDER } from './interfaces/embedding-provider.interface.js';
import type { EmbeddingProvider } from './interfaces/embedding-provider.interface.js';
import { LLM_PROVIDER } from './interfaces/llm-provider.interface.js';
import type { LlmProvider } from './interfaces/llm-provider.interface.js';

const VALID_ENV: NodeJS.ProcessEnv = {
  PORT: '3001',
  DATABASE_URL: 'postgresql://techadvisor:techadvisor@localhost:5432/techadvisor?schema=public',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'change-me-to-a-long-random-secret',
  BASE_CURRENCY: 'USD',
  SUPPORTED_CURRENCIES: 'USD,EUR',
  EMBEDDING_PROVIDER: 'fake',
  EMBEDDING_DIM: '24',
};

describe('AiModule', () => {
  it('exposes a working EmbeddingProvider with EMBEDDING_PROVIDER=fake', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, AiModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(parseEnv({ ...VALID_ENV }))
      .compile();

    const provider = moduleRef.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
    const vectors = await provider.embed(['boot check']);

    expect(provider.dimensions).toBe(24);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(24);
    await moduleRef.close();
  });

  it('exposes a working LlmProvider with the default fake LLM config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, AiModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(parseEnv({ ...VALID_ENV }))
      .compile();

    const provider = moduleRef.get<LlmProvider>(LLM_PROVIDER);
    const result = await provider.generate({
      system: 'Answer briefly.',
      messages: [{ role: 'user', content: 'boot check' }],
    });

    expect(result.text).toContain('fake response');
    await moduleRef.close();
  });
});
