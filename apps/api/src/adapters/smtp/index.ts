import nodemailer from 'nodemailer';

import { EmailDeliveryError, type EmailSender } from '../../platform/mail/email-sender.js';

export interface SmtpConfig {
  host: string;
  port: number;
  /**
   * `none`: plain connection (Mailpit locally). `starttls`: upgrade the connection and refuse to
   * send without it (SES SMTP on port 587). `tls`: TLS from the first byte (port 465).
   */
  security: 'none' | 'starttls' | 'tls';
  user?: string;
  password?: string;
  /** Sender address, optionally with a display name: `Consulvia <no-responder@example>`. */
  from: string;
  connectionTimeoutMs?: number;
}

export interface SmtpEmailSender extends EmailSender {
  /** Closes the pooled connections. */
  close(): void;
}

/**
 * SMTP adapter: Mailpit in development, the SES SMTP interface in production. Delivery failures
 * are reported as `EmailDeliveryError`, whose message carries neither the recipient nor the body.
 */
export function createSmtpEmailSender(config: SmtpConfig): SmtpEmailSender {
  const timeout = config.connectionTimeoutMs ?? 10_000;
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    ...(config.user === undefined
      ? {}
      : { auth: { user: config.user, pass: config.password ?? '' } }),
    pool: true,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: 3 * timeout,
  });

  return {
    async send(message) {
      try {
        await transport.sendMail({
          from: config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
        });
      } catch (error) {
        throw new EmailDeliveryError({ cause: error });
      }
    },
    close() {
      transport.close();
    },
  };
}
