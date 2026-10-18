import { randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';

import {
  localWhatsappControl,
  localWhatsappMessage,
  type LOCAL_WHATSAPP_MODES,
} from '../../db/schema/notifications.js';
import type {
  WebhookHeaders,
  WhatsAppSender,
  WhatsAppSendRequest,
  WhatsAppSendResult,
} from '../../modules/notifications/application/ports.js';
import { isApprovedTemplate, whatsappBody } from '../../modules/notifications/index.js';
import type { Db } from '../../platform/db/pool.js';

import { parseEnvelope, signBody, verifySignature } from './envelope.js';

/**
 * The local WhatsApp simulator (`WHATSAPP_PROVIDER=local`): a working provider that needs no
 * account. It keeps its phone, the messages it was given and the replies typed into it, in
 * Postgres, so the API and the worker see the same one. It behaves like the provider where it
 * matters to the product: it rejects a template that was not approved, a number that is not a
 * number, and a number that is not on WhatsApp (the reserved prefix `+999` always is not), and it
 * can be put into an outage or made to reject every template from the developer console.
 */

export type LocalWhatsAppMode = (typeof LOCAL_WHATSAPP_MODES)[number];

/** Numbers that start with this belong to no country: the simulator says they are not on WhatsApp. */
export const RESERVED_TEST_PREFIX = '+999';

const E164 = /^\+[1-9]\d{7,14}$/;

export interface LocalWhatsAppSender extends WhatsAppSender {
  /** The `X-Hub-Signature-256` value of a body, as the provider would sign it. */
  signBody(rawBody: Buffer | string): string;
}

export interface LocalWhatsAppOptions {
  db: Db;
  /** The app secret that signs the webhook. */
  appSecret: string;
}

/** The single control row, created on first use. */
async function readControl(db: Db) {
  await db.insert(localWhatsappControl).values({ id: 1 }).onConflictDoNothing();
  const [row] = await db.select().from(localWhatsappControl).where(eq(localWhatsappControl.id, 1));
  if (!row) throw new Error('the simulator control row is missing');
  return row;
}

export function createLocalWhatsAppSender(options: LocalWhatsAppOptions): LocalWhatsAppSender {
  const { db, appSecret } = options;

  async function existing(idempotencyKey: string): Promise<WhatsAppSendResult | null> {
    const [row] = await db
      .select({ providerMessageId: localWhatsappMessage.providerMessageId })
      .from(localWhatsappMessage)
      .where(eq(localWhatsappMessage.idempotencyKey, idempotencyKey));
    return row ? { status: 'accepted', providerMessageId: row.providerMessageId } : null;
  }

  return {
    async send(request: WhatsAppSendRequest): Promise<WhatsAppSendResult> {
      const duplicate = await existing(request.idempotencyKey);
      if (duplicate) return duplicate;

      const control = await readControl(db);
      if (control.mode === 'down') {
        return { status: 'retryable', message: 'the simulator is in an outage' };
      }
      if (control.mode === 'reject_template' || !isApprovedTemplate(request.templateKey)) {
        return { status: 'rejected', reason: 'template_rejected' };
      }
      if (!E164.test(request.to)) return { status: 'rejected', reason: 'invalid_number' };
      if (
        request.to.startsWith(RESERVED_TEST_PREFIX) ||
        control.unreachableNumbers.includes(request.to)
      ) {
        return { status: 'rejected', reason: 'not_on_whatsapp' };
      }

      const providerMessageId = `wamid.${randomUUID()}`;
      const [inserted] = await db
        .insert(localWhatsappMessage)
        .values({
          providerMessageId,
          idempotencyKey: request.idempotencyKey,
          direction: 'outbound',
          number: request.to,
          templateKey: request.templateKey,
          body: whatsappBody(request.templateKey, request.vars),
          status: 'accepted',
        })
        .onConflictDoNothing()
        .returning({ providerMessageId: localWhatsappMessage.providerMessageId });
      if (inserted) return { status: 'accepted', providerMessageId: inserted.providerMessageId };
      // Another process took the key a moment ago: it is the same message.
      return (
        (await existing(request.idempotencyKey)) ?? { status: 'retryable', message: 'conflict' }
      );
    },
    signBody: (rawBody) => signBody(appSecret, rawBody),
    verifyWebhook: (rawBody: Buffer | string, headers: WebhookHeaders) =>
      verifySignature(appSecret, rawBody, headers),
    parseEvents: parseEnvelope,
  };
}

export interface LocalWhatsAppMessageDto {
  id: string;
  providerMessageId: string;
  direction: 'outbound' | 'inbound';
  number: string;
  templateKey: string | null;
  body: string;
  status: string;
  errorCode: string | null;
  createdAt: Date;
}

/** Order in which a message advances; a status report that goes back is ignored. */
const PROGRESS: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3 };

export interface LocalWhatsAppControls {
  /** The newest messages first. */
  messages(limit: number): Promise<LocalWhatsAppMessageDto[]>;
  mode(): Promise<LocalWhatsAppMode>;
  setMode(mode: LocalWhatsAppMode): Promise<void>;
  unreachableNumbers(): Promise<string[]>;
  setUnreachable(number: string, unreachable: boolean): Promise<void>;
  /** Moves an outbound message along (`sent`, `delivered`, `read`) or fails it; never backwards. */
  setStatus(
    providerMessageId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    errorCode?: string,
  ): Promise<boolean>;
  /** Puts a reply into the phone and returns the id of its event. */
  recordInbound(input: { from: string; text: string }): Promise<{
    eventId: string;
    providerMessageId: string;
  }>;
}

export function createLocalWhatsAppControls(db: Db): LocalWhatsAppControls {
  return {
    async messages(limit) {
      const rows = await db
        .select()
        .from(localWhatsappMessage)
        .orderBy(desc(localWhatsappMessage.createdAt), desc(localWhatsappMessage.id))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        providerMessageId: row.providerMessageId,
        direction: row.direction === 'inbound' ? 'inbound' : 'outbound',
        number: row.number,
        templateKey: row.templateKey,
        body: row.body,
        status: row.status,
        errorCode: row.errorCode,
        createdAt: row.createdAt,
      }));
    },
    async mode() {
      const { mode } = await readControl(db);
      return mode === 'down' || mode === 'reject_template' ? mode : 'ok';
    },
    async setMode(mode) {
      await readControl(db);
      await db.update(localWhatsappControl).set({ mode }).where(eq(localWhatsappControl.id, 1));
    },
    async unreachableNumbers() {
      return [...(await readControl(db)).unreachableNumbers];
    },
    async setUnreachable(number, unreachable) {
      await readControl(db);
      await db
        .update(localWhatsappControl)
        .set({
          unreachableNumbers: unreachable
            ? sql`(select array_agg(distinct n) from unnest(array_append(${localWhatsappControl.unreachableNumbers}, ${number}::text)) as n)`
            : sql`array_remove(${localWhatsappControl.unreachableNumbers}, ${number}::text)`,
        })
        .where(eq(localWhatsappControl.id, 1));
    },
    async setStatus(providerMessageId, status, errorCode) {
      const [row] = await db
        .select({ status: localWhatsappMessage.status })
        .from(localWhatsappMessage)
        .where(
          and(
            eq(localWhatsappMessage.providerMessageId, providerMessageId),
            eq(localWhatsappMessage.direction, 'outbound'),
          ),
        );
      if (!row) return false;
      // A message that failed or was read has nothing after it.
      if (row.status === 'failed' || row.status === 'read') return false;
      if (status !== 'failed') {
        const current = PROGRESS[row.status];
        const next = PROGRESS[status];
        if (current === undefined || next === undefined || next <= current) return false;
      }
      await db
        .update(localWhatsappMessage)
        .set({ status, errorCode: status === 'failed' ? (errorCode ?? null) : null })
        .where(eq(localWhatsappMessage.providerMessageId, providerMessageId));
      return true;
    },
    async recordInbound({ from, text }) {
      const providerMessageId = `wamid.in.${randomUUID()}`;
      await db.insert(localWhatsappMessage).values({
        providerMessageId,
        direction: 'inbound',
        number: from,
        body: text,
        status: 'received',
      });
      return { eventId: providerMessageId, providerMessageId };
    },
  };
}
