import { createFakeEmailSender } from '../adapters/fake-email/index.js';
import { createOutboxEmailSender } from '../adapters/outbox-email/index.js';
import { createSmtpEmailSender } from '../adapters/smtp/index.js';
import type { EmailSender } from '../platform/mail/email-sender.js';

import type { MailConfig, OutboxConfig } from './config.js';

export interface ConfiguredEmail {
  sender: EmailSender;
  /**
   * `smtp` delivers to the configured server; `outbox` writes each message to a folder; `fake` only
   * keeps messages in memory.
   */
  kind: 'smtp' | 'outbox' | 'fake';
  close(): void;
}

/**
 * Composition root for email: SMTP when the deployment configures a server (Mailpit locally, SES
 * SMTP in production, where the configuration makes it mandatory), a folder of `.eml` files when it
 * configures one instead (the desktop profile has no mail server), otherwise an in-memory sender
 * that delivers nothing. The caller logs a warning for the last case.
 */
export function createConfiguredEmail(
  mail: MailConfig | undefined,
  outbox?: OutboxConfig,
): ConfiguredEmail {
  if (!mail && outbox) {
    return {
      sender: createOutboxEmailSender({ dir: outbox.dir, from: outbox.from }),
      kind: 'outbox',
      close: () => undefined,
    };
  }
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
