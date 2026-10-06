import { Module } from '@nestjs/common';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';

@Module({
  imports: [AuthSecurityModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
