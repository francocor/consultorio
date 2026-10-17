import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { message, messageEvent } from '../../src/db/schema/notifications.js';
import { recordOptIn } from '../../src/modules/notifications/application/preferences.js';
import type { AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createTestAdapterResolver } from '../support/adapters.js';
import { createRecordingJobClient } from '../support/jobs.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * The WhatsApp webhook: signed, idempotent, tenant from our own record, and deaf to anything that
 * is not an event of a message we sent.
 */

const patientActor: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
const whatsapp = createFakeWhatsAppSender();
let slot = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const jobs = createRecordingJobClient();
  scheduling = await createSchedulingHttpWorld(runtime, {
    slug: 'wa-webhook',
    app: { adapters: createTestAdapterResolver({ whatsapp }), jobs },
  });
  notes = createNotificationsWorld(scheduling, { jobs, whatsapp });
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(async () => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.jobs.jobs.length = 0;
  notes.email.reset();
  await notes.setTenant({ status: 'active' });
});

const slotTime = () => {
  slot += 1;
  return `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
};

/** A patient opted in to WhatsApp whose reminder went out over WhatsApp. */
async function whatsappReminder(contact: { email?: string | null; phone?: string } = {}) {
  const patientId = await notes.patient({
    phone: contact.phone ?? '1144445555',
    email: contact.email === undefined ? 'respaldo@example.test' : contact.email,
  });
  await scheduling.inTenant((tx) =>
    recordOptIn(tx, {
      patientId,
      channel: 'whatsapp',
      source: 'online_booking',
      actor: patientActor,
    }),
  );
  const appointment = await notes.book(patientId, 1 + Math.floor(slot / 8), slotTime());
  const messageId = await notes.queue({
    kind: 'reminder',
    channel: 'whatsapp',
    patientId,
    appointmentId: appointment.id,
    plannedStartsAt: new Date(appointment.startsAt),
    appointmentVersion: appointment.version,
    dedupeKey: `wa:${appointment.id}:whatsapp`,
  });
  await notes.runAllJobs();
  const sent = await notes.message(messageId);
  expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'sent', channel: 'whatsapp' });
  return { patientId, appointment, messageId, providerMessageId: sent.providerMessageId ?? '' };
}

const post = (events: unknown[], options: { sign?: boolean; rawOverride?: string } = {}) => {
  const raw = options.rawOverride ?? JSON.stringify({ events });
  return scheduling.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: {
      'content-type': 'application/json',
      ...(options.sign === false ? {} : { 'x-hub-signature-256': whatsapp.signBody(raw) }),
    },
    payload: raw,
  });
};

const statusEvent = (providerMessageId: string, status: string, eventId = crypto.randomUUID()) => ({
  kind: 'status',
  eventId,
  providerMessageId,
  status,
  occurredAt: '2031-05-06T12:05:00.000Z',
});

const events = async (messageId: string) =>
  scheduling.inTenant((tx) =>
    tx.select().from(messageEvent).where(eq(messageEvent.messageId, messageId)),
  );

describe('the signature', () => {
  it('rejects a request with an invalid signature and changes nothing', async () => {
    const r = await whatsappReminder();
    const raw = JSON.stringify({ events: [statusEvent(r.providerMessageId, 'delivered')] });

    const response = await scheduling.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      },
      payload: raw,
    });

    expect(response.statusCode).toBe(401);
    expect((await notes.message(r.messageId)).status).toBe('sent');
    expect(await events(r.messageId)).toEqual([]);
  });

  it('rejects an unsigned request', async () => {
    const r = await whatsappReminder();

    const response = await post([statusEvent(r.providerMessageId, 'delivered')], { sign: false });

    expect(response.statusCode).toBe(401);
    expect((await notes.message(r.messageId)).status).toBe('sent');
  });

  it('checks the signature over the bytes that arrived, not over a parsed copy', async () => {
    const r = await whatsappReminder();
    const raw = JSON.stringify({ events: [statusEvent(r.providerMessageId, 'delivered')] });
    const signed = whatsapp.signBody(raw);

    // Same content, different bytes (extra whitespace): the signature no longer matches.
    const response = await scheduling.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signed },
      payload: `${raw} `,
    });

    expect(response.statusCode).toBe(401);
    expect((await notes.message(r.messageId)).status).toBe('sent');
  });
});

describe('delivery receipts', () => {
  it('moves the message to delivered, then read, with the time of the event', async () => {
    const r = await whatsappReminder();

    const delivered = await post([statusEvent(r.providerMessageId, 'delivered')]);
    const read = await post([statusEvent(r.providerMessageId, 'read')]);

    expect(delivered.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    const row = await notes.message(r.messageId);
    expect(row.status).toBe('read');
    expect(row.deliveredAt?.toISOString()).toBe('2031-05-06T12:05:00.000Z');
    expect(row.readAt?.toISOString()).toBe('2031-05-06T12:05:00.000Z');
  });

  it('counts a replayed event once: the same event id changes nothing the second time', async () => {
    const r = await whatsappReminder();
    const eventId = crypto.randomUUID();

    const first = await post([statusEvent(r.providerMessageId, 'delivered', eventId)]);
    const second = await post([statusEvent(r.providerMessageId, 'delivered', eventId)]);

    expect(first.json()).toEqual({ processed: 1 });
    expect(second.json()).toEqual({ processed: 0 });
    expect(await events(r.messageId)).toHaveLength(1);
    expect((await notes.message(r.messageId)).status).toBe('delivered');
  });

  it('does not go back: a late "delivered" after "read" is ignored', async () => {
    const r = await whatsappReminder();
    await post([statusEvent(r.providerMessageId, 'read')]);

    await post([statusEvent(r.providerMessageId, 'delivered')]);

    expect((await notes.message(r.messageId)).status).toBe('read');
  });

  it('ignores an event about a message nobody sent: no record, no error', async () => {
    const before = await scheduling.inTenant((tx) => tx.select().from(messageEvent));

    const response = await post([statusEvent('wamid.never-sent', 'delivered')]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ processed: 0 });
    expect(await scheduling.inTenant((tx) => tx.select().from(messageEvent))).toHaveLength(
      before.length,
    );
  });

  it('takes the organization from its own record of the message, never from the request', async () => {
    const other = await createTestTenant(runtime, { slug: 'wa-webhook-other' });
    const r = await whatsappReminder();

    // The body names another organization; the message is found by its provider id alone.
    const response = await post([
      { ...statusEvent(r.providerMessageId, 'delivered'), tenantId: other.id },
    ]);

    expect(response.statusCode).toBe(200);
    expect((await notes.message(r.messageId)).status).toBe('delivered');
  });

  it('still applies receipts while the organization is read-only (a webhook, not a user action)', async () => {
    const r = await whatsappReminder();
    await notes.setTenant({ status: 'read_only' });

    const response = await post([statusEvent(r.providerMessageId, 'delivered')]);

    expect(response.statusCode).toBe(200);
    expect((await notes.message(r.messageId)).status).toBe('delivered');
  });

  it('falls back to email when the provider reports a failure after taking the message', async () => {
    const r = await whatsappReminder({ email: 'cae@example.test' });

    await post([{ ...statusEvent(r.providerMessageId, 'failed'), errorCode: 'not_on_whatsapp' }]);

    expect(await notes.message(r.messageId)).toMatchObject({
      status: 'failed',
      failureReason: 'not_on_whatsapp',
    });
    await notes.runAllJobs();
    expect(notes.email.sent.map((mail) => mail.to)).toEqual(['cae@example.test']);
    // The booking also planned its own reminder (the planner is wired); this is the message of the test.
    const rows = (await notes.messagesOf(r.appointment.id)).filter((row) =>
      row.dedupeKey.startsWith('wa:'),
    );
    expect(rows.map((row) => [row.channel, row.status])).toEqual([
      ['whatsapp', 'failed'],
      ['email', 'sent'],
    ]);
  });

  it('asks reception to follow up when the failure leaves no other channel', async () => {
    const r = await whatsappReminder({ email: null });

    await post([statusEvent(r.providerMessageId, 'failed')]);

    expect(await notes.message(r.messageId)).toMatchObject({
      status: 'failed',
      failureReason: 'delivery_failed',
    });
    expect(await notes.worklistKinds(r.appointment.id)).toEqual(['reminder_not_delivered']);
  });
});

describe('replies', () => {
  it('ignores a reply from a number the organization never wrote to: nothing is created', async () => {
    const count = async (table: string) =>
      (
        await scheduling.inTenant((tx) =>
          tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`),
        )
      ).rows[0]?.n;
    const before = { patient: await count('patient'), inbound: await count('inbound_message') };

    const response = await post([
      {
        kind: 'inbound',
        eventId: crypto.randomUUID(),
        from: '+5493515550000',
        text: '1',
        occurredAt: '2031-05-06T12:05:00.000Z',
      },
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ processed: 0 });
    expect({ patient: await count('patient'), inbound: await count('inbound_message') }).toEqual(
      before,
    );
  });

  it('answers 404 when no WhatsApp provider is configured', async () => {
    const bare = await createSchedulingHttpWorld(runtime, { slug: 'wa-webhook-bare' });
    try {
      const raw = JSON.stringify({ events: [] });
      const response = await bare.app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': whatsapp.signBody(raw),
        },
        payload: raw,
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

describe('what the log keeps', () => {
  it('keeps no address and no text of the provider in the events it records', async () => {
    const r = await whatsappReminder({ phone: '1155550000' });
    await post([statusEvent(r.providerMessageId, 'delivered')]);

    const rows = await scheduling.inTenant((tx) =>
      tx.select().from(messageEvent).where(eq(messageEvent.messageId, r.messageId)),
    );
    const stored = JSON.stringify([rows, await notes.message(r.messageId)]);

    expect(stored).not.toContain('1155550000');
    expect(stored).not.toContain('5491155550000');
    expect(
      (
        await scheduling.inTenant((tx) =>
          tx
            .select({ id: message.id })
            .from(message)
            .where(and(eq(message.id, r.messageId))),
        )
      ).length,
    ).toBe(1);
  });
});
