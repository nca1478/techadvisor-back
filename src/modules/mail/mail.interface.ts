/**
 * Minimal transactional-mail contract. The rest of the code depends only on
 * this interface — never on a vendor SDK (see AGENTS.md §5.10: vendor imports
 * live solely in `adapters/`).
 */
export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailProvider {
  send(input: SendMailInput): Promise<void>;
}

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');
