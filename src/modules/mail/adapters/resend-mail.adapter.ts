import { Injectable } from '@nestjs/common';
import { Resend } from 'resend';
import { APP_CONFIG } from '../../../config/app-config.module.js';
import type { AppConfig } from '../../../config/env.schema.js';
import { Inject } from '@nestjs/common';
import type { MailProvider, SendMailInput } from '../mail.interface.js';

/**
 * Resend adapter — the ONLY place importing the `resend` SDK (AGENTS.md §2).
 * Timeouts/errors are normalized to plain Errors; callers map them to 503.
 */
@Injectable()
export class ResendMailAdapter implements MailProvider {
  private readonly client: Resend;
  private readonly from: string;
  private readonly replyTo?: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (!config.RESEND_API_KEY || !config.MAIL_FROM) {
      throw new Error('RESEND_API_KEY and MAIL_FROM are required for the resend adapter');
    }
    this.client = new Resend(config.RESEND_API_KEY);
    this.from = config.MAIL_FROM;
    this.replyTo = config.MAIL_REPLY_TO ?? undefined;
  }

  async send(input: SendMailInput): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(this.replyTo ? { replyTo: this.replyTo } : {}),
    });
    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }
}
