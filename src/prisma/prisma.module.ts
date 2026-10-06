import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** Global database module — import once via AppModule, inject PrismaService anywhere. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
