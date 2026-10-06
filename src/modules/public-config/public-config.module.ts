import { Module } from '@nestjs/common';
import { PublicConfigController } from './public-config.controller.js';

@Module({
  controllers: [PublicConfigController],
})
export class PublicConfigModule {}
