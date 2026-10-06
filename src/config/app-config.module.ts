import { Global, Module } from '@nestjs/common';
import { type AppConfig, parseEnv } from './env.schema.js';

/** Injection token for the validated, typed application configuration. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Global configuration module. The factory runs `parseEnv()` once at boot, so
 * a missing/invalid variable fails application startup with a legible error.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => parseEnv(),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
