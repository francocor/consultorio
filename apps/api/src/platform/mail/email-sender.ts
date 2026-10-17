/**
 * Transactional email port (design section 6). Modules ask for an email to be sent; which provider
 * delivers it is an adapter: SMTP (Mailpit locally, SES SMTP in production) or an in-memory fake
 * in tests. The native SES API adapter arrives with `notifications` in Stage 3.
 *
 * Only account and security flows go through here: a person's own password reset, staff invitation
 * and the notice to the owners when an admin adds a professional (decision D19). Nothing
 * clinical is ever put in an email.
 */
export interface EmailMessage {
  /** One recipient address. */
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * The organization the message is about. The sender that routes by organization needs it: a demo
   * organization's email never goes through the real provider.
   */
  tenant?: { id: string; isDemo: boolean };
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
