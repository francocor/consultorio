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

/** The most messages the fake remembers: it serves demo organizations in a process that stays up. */
export const FAKE_EMAIL_CAPACITY = 1_000;

/** In-memory email sender for tests and for development without a mail server. */
export function createFakeEmailSender(
  options: { failWith?: Error; capacity?: number } = {},
): FakeEmailSender {
  const sent: EmailMessage[] = [];
  const capacity = options.capacity ?? FAKE_EMAIL_CAPACITY;

  return {
    get sent() {
      return sent;
    },
    send(message) {
      if (options.failWith) {
        return Promise.reject(new EmailDeliveryError({ cause: options.failWith }));
      }
      sent.push(message);
      // The oldest goes first: what a test or a console looks at is the latest.
      if (sent.length > capacity) sent.splice(0, sent.length - capacity);
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
