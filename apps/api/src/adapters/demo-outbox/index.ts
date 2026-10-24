import { desc, eq, sql } from 'drizzle-orm';

import { demoOutbox } from '../../db/schema/demo-outbox.js';
import type { Db } from '../../platform/db/pool.js';
import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailSender,
} from '../../platform/mail/email-sender.js';

/**
 * The email sender of the demo organizations when the deployment keeps what they send (Stage 5
 * integration, task 5.48). A demo organization never reaches a real mail server; what it "sends" is
 * written to `demo_outbox`, and the provider console lists it, so a demo can be walked through
 * without a mailbox: the portal sign-in code, the activation link and the notices are read there.
 *
 * `forward` is the development mail catcher (Mailpit) the browser suites read. It is given only
 * outside production, where the configured SMTP server is that catcher; in production nothing is
 * ever forwarded, so a demo organization's message reaches the outbox and nowhere else.
 */

export interface DemoOutboxEmailOptions {
  /** The runtime connection: the application role inserts, nothing more. */
  db: Db;
  /** The development catcher. Absent in production. */
  forward?: EmailSender | undefined;
}

export function createDemoOutboxEmailSender(options: DemoOutboxEmailOptions): EmailSender {
  return {
    async send(message: EmailMessage) {
      if (!message.tenant) {
        // The outbox is per organization, and the routing in front of this sender refuses a
        // message that does not say which one it is about.
        throw new EmailDeliveryError({
          cause: new Error('The demo outbox needs the organization.'),
        });
      }
      try {
        await options.db.insert(demoOutbox).values({
          targetTenantId: message.tenant.id,
          toAddress: message.to,
          subject: message.subject,
          bodyText: message.text,
        });
      } catch (error) {
        throw new EmailDeliveryError({ cause: error });
      }
      await options.forward?.send(message);
    },
  };
}

/** One message of the outbox, as the provider console lists it. */
export interface DemoOutboxMessage {
  id: string;
  to: string;
  subject: string;
  text: string;
  createdAt: Date;
}

export interface DemoOutboxReader {
  /** The latest messages, newest first; with `to`, only those sent to that address. */
  list(options: { limit: number; to?: string | undefined }): Promise<DemoOutboxMessage[]>;
}

export function createDemoOutboxReader(db: Db): DemoOutboxReader {
  return {
    async list({ limit, to }) {
      const rows = await db
        .select()
        .from(demoOutbox)
        .where(
          to === undefined ? undefined : eq(sql`lower(${demoOutbox.toAddress})`, to.toLowerCase()),
        )
        .orderBy(desc(demoOutbox.createdAt), desc(demoOutbox.id))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        to: row.toAddress,
        subject: row.subject,
        text: row.bodyText,
        createdAt: row.createdAt,
      }));
    },
  };
}

/** How long the outbox keeps what a demo organization sent. */
export const DEMO_OUTBOX_TTL_MS = 24 * 3_600_000;

/**
 * Removes what the outbox kept for longer than `ttlMs` (JD-S5 R1-A-S): the rows are fictitious email
 * read in the provider console, and a demo that is never reset would otherwise keep them for good.
 * The runtime role cannot delete from the table; the function of the database does, and never
 * touches a row younger than an hour. Returns how many rows it removed.
 */
export async function purgeDemoOutbox(
  db: Db,
  now: Date,
  ttlMs: number = DEMO_OUTBOX_TTL_MS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - ttlMs).toISOString();
  const result = await db.execute<{ removed: number }>(
    sql`select app.demo_outbox_purge(${cutoff}::timestamptz) as removed`,
  );
  return result.rows[0]?.removed ?? 0;
}

/** What a deployment does with the email of a demo organization (see `demoEmailPolicy`). */
export interface DemoEmailPolicy {
  /** Keep what the demo sends in `demo_outbox`. */
  record: boolean;
  /** Also hand it to the configured development catcher. */
  forward: boolean;
}

/**
 * The outbox is kept wherever somebody can read it: outside production always, and in production
 * only for a demo or staging deployment that turned the provider console on (the console is where
 * it is read). The catcher gets a copy outside production only. Everywhere else the demo's email
 * goes to a throwaway in-memory sender, as before.
 */
export function demoEmailPolicy(config: {
  nodeEnv: string;
  providers: { localProvidersConsole: boolean };
}): DemoEmailPolicy {
  const production = config.nodeEnv === 'production';
  return { record: !production || config.providers.localProvidersConsole, forward: !production };
}
