import { createFakeEmailSender } from '../adapters/fake-email/index.js';
import { createSmtpEmailSender } from '../adapters/smtp/index.js';
import type { EmailSender } from '../platform/mail/email-sender.js';

import type { MailConfig } from './config.js';

export interface ConfiguredEmail {
  sender: EmailSender;
  /** `smtp` delivers to the configured server; `fake` only keeps messages in memory. */
  kind: 'smtp' | 'fake';
  close(): void;
}

/**
 * Composition root for email: SMTP when the deployment configures a server (Mailpit locally, SES
 * SMTP in production, where the configuration makes it mandatory), otherwise an in-memory sender
 * that delivers nothing. The caller logs a warning for the second case.
 */
export function createConfiguredEmail(mail: MailConfig | undefined): ConfiguredEmail {
  if (!mail) {
    return { sender: createFakeEmailSender(), kind: 'fake', close: () => undefined };
  }
  const smtp = createSmtpEmailSender({
    host: mail.host,
    port: mail.port,
    security: mail.security,
    from: mail.from,
    ...(mail.user === undefined ? {} : { user: mail.user }),
    ...(mail.password === undefined ? {} : { password: mail.password }),
  });
  return {
    sender: smtp,
    kind: 'smtp',
    close: () => {
      smtp.close();
    },
  };
}
