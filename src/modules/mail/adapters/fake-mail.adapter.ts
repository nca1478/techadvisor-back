import { Injectable, type LoggerService } from '@nestjs/common';
import type { MailProvider, SendMailInput } from '../mail.interface.js';

/**
 * Offline mail adapter (dev/test default). Logs metadata only — never the
 * full OTP — so secrets stay out of log aggregators.
 */
@Injectable()
export class FakeMailAdapter implements MailProvider {
  constructor(private readonly logger: LoggerService) {}

  async send(input: SendMailInput): Promise<void> {
    this.logger.log(`[fake-mail] to=${input.to} subject=${input.subject}`, 'FakeMail');
    await Promise.resolve();
  }
}
