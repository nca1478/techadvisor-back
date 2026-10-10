import { Module } from '@nestjs/common';
import { AiCallLoggerModule } from '../observability/ai-call-logger.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [AiCallLoggerModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
