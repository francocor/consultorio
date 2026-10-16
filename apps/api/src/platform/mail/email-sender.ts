/**
 * Transactional email port (design section 6). Modules ask for an email to be sent; which provider
 * delivers it is an adapter: SMTP (Mailpit locally, SES SMTP in production) or an in-memory fake
 * in tests. The native SES API adapter arrives with `notifications` in Stage 3.
 *
 * Only account flows go through here: a person's own password reset and staff invitation. Nothing
 * clinical is ever put in an email.
 */
export interface EmailMessage {
  /** One recipient address. */
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  /**
   * Hands the message to the provider. Resolves when the provider accepted it; rejects when it
   * did not, so a caller can decide whether the failure matters.
   */
  send(message: EmailMessage): Promise<void>;
}

/** Why an email could not be sent. The message never includes the body or the address. */
export class EmailDeliveryError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('email delivery failed', options);
    this.name = 'EmailDeliveryError';
  }
}
