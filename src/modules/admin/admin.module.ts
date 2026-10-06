import { Module } from '@nestjs/common';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { AdminController } from './admin.controller.js';

@Module({
  imports: [AuthSecurityModule],
  controllers: [AdminController],
})
export class AdminModule {}
