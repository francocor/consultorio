import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import nodemailer from 'nodemailer';

import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailSender,
} from '../../platform/mail/email-sender.js';

export interface OutboxEmailConfig {
  /** The folder the messages are written to. Created on demand. */
  dir: string;
  /** Sender address, optionally with a display name: `Consulvia <no-responder@localhost>`. */
  from: string;
  clock?: () => Date;
}

/** What the tray lists for each message: small, and enough to find the link without opening the file. */
export interface OutboxEntry {
  id: string;
  /** The name of the `.eml` file, in the same folder. */
  file: string;
  createdAt: string;
  from: string;
  to: string;
  subject: string;
  /** The web links in the text of the message: the reset link is what a person came for. */
  links: string[];
}

const WEB_LINK = /https?:\/\/[^\s<>"')\]]+/g;

/** `20261020T153045123Z`: sorts as time does, and has no characters a file name refuses. */
const stamp = (at: Date) => at.toISOString().replaceAll(/[-:.]/g, '');

async function writeAtomically(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Email without a mail server (the desktop profile has none): each message becomes an `.eml` file in a
 * folder that a person can open, plus a `.json` entry beside it with what the tray needs to list it.
 * Delivery means "the file is complete": the message counts as sent once both are on the disk. The entry
 * is written last, so a listing never shows a message whose file is not whole.
 *
 * One entry per message and not one index file: the API and the worker both send, and two processes
 * rewriting a shared index would lose entries. A file name carries the time and eight random
 * characters of the id, never the address or the subject.
 *
 * The messages hold links with live tokens (a password reset): the folder lives in the data of the
 * user, like the database does, and a reset link expires like any other.
 */
export function createOutboxEmailSender(config: OutboxEmailConfig): EmailSender {
  const clock = config.clock ?? (() => new Date());
  // The transport only renders the message; nothing is sent anywhere.
  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });

  return {
    async send(message: EmailMessage): Promise<void> {
      try {
        const id = randomUUID();
        const now = clock();
        const file = `${stamp(now)}-${id.slice(0, 8)}.eml`;
        const rendered = await composer.sendMail({
          from: config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          date: now,
        });
        await mkdir(config.dir, { recursive: true });
        // `buffer: true` above makes the rendered message a Buffer, not a stream.
        if (!Buffer.isBuffer(rendered.message)) throw new Error('the message was not rendered');
        await writeAtomically(join(config.dir, file), rendered.message);
        const entry: OutboxEntry = {
          id,
          file,
          createdAt: now.toISOString(),
          from: config.from,
          to: message.to,
          subject: message.subject,
          links: [...new Set(message.text.match(WEB_LINK) ?? [])],
        };
        await writeAtomically(
          join(config.dir, `${file.slice(0, -'.eml'.length)}.json`),
          `${JSON.stringify(entry, null, 2)}\n`,
        );
      } catch (error) {
        // The message of a failure never carries the recipient or the body.
        throw new EmailDeliveryError({ cause: error });
      }
    },
  };
}
