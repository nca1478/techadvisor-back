import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { FakeMailAdapter } from './adapters/fake-mail.adapter.js';
import { ResendMailAdapter } from './adapters/resend-mail.adapter.js';
import { MAIL_PROVIDER, type MailProvider } from './mail.interface.js';

/**
 * Selects the mail adapter from `MAIL_PROVIDER`. Only this factory knows the
 * vendor; services inject `MAIL_PROVIDER` and stay vendor-agnostic.
 */
@Injectable()
export class MailProviderFactory {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  create(): MailProvider {
    if (this.config.MAIL_PROVIDER === 'resend') {
      return new ResendMailAdapter(this.config);
    }
    return new FakeMailAdapter(new Logger('FakeMail'));
  }
}

export { MAIL_PROVIDER };
export type { MailProvider };
