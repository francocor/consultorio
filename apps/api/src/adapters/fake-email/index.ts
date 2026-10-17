import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailSender,
} from '../../platform/mail/email-sender.js';

export interface FakeEmailSender extends EmailSender {
  /** Every message accepted, oldest first. */
  readonly sent: readonly EmailMessage[];
  lastTo(address: string): EmailMessage | undefined;
  /** The first web link in the text of a message. */
  linkIn(message: EmailMessage | undefined): string | undefined;
  clear(): void;
}

/** In-memory email sender for tests and for development without a mail server. */
export function createFakeEmailSender(options: { failWith?: Error } = {}): FakeEmailSender {
  const sent: EmailMessage[] = [];

  return {
    get sent() {
      return sent;
    },
    send(message) {
      if (options.failWith) {
        return Promise.reject(new EmailDeliveryError({ cause: options.failWith }));
      }
      sent.push(message);
      return Promise.resolve();
    },
    lastTo(address) {
      const wanted = address.toLowerCase();
      return sent.findLast((message) => message.to.toLowerCase() === wanted);
    },
    linkIn(message) {
      return message?.text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
    },
    clear() {
      sent.length = 0;
    },
  };
}
