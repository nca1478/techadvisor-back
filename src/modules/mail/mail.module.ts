import { Module } from '@nestjs/common';
import { MAIL_PROVIDER } from './mail.interface.js';
import { MailProviderFactory } from './mail.factory.js';

/**
 * Global mail module: exposes `MAIL_PROVIDER` (fake/resend). Fake by
 * default so local dev and CI need no credentials.
 */
@Module({
  providers: [
    MailProviderFactory,
    {
      provide: MAIL_PROVIDER,
      useFactory: (factory: MailProviderFactory) => factory.create(),
      inject: [MailProviderFactory],
    },
  ],
  exports: [MAIL_PROVIDER],
})
export class MailModule {}
