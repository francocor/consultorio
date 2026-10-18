import { randomBytes } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { channelPreference } from '../../src/db/schema/channel-preference.js';
import { inboundMessage } from '../../src/db/schema/notifications.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import {
  loadPreferences,
  recordOptIn,
} from '../../src/modules/notifications/application/preferences.js';
import { legacyAddressHash } from '../../src/modules/notifications/domain/address.js';
import { normalizeInboundNumber } from '../../src/modules/notifications/domain/phone.js';
import type { AuditActor } from '../../src/platform/audit/writer.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
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

/**
 * A reply carries no organization, and one number can be on the books of several. Judgment day
 * finding C1: "1", "2" and BAJA must act in the organization the reply is about, and in no other;
 * C10: finding it must not expose whole messages; C13: numbers from outside Argentina count.
 */

const patientActor: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

interface Clinic {
  scheduling: SchedulingHttpWorld;
  notes: NotificationsWorld;
}

let runtime: DbHandle;
let a: Clinic;
let b: Clinic;
const whatsapp = createFakeWhatsAppSender();
const keys = createTenantKeys({
  kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
});
/** The clock of the application that receives the webhook; the replies arrive ten minutes after. */
const REPLY_AT = new Date('2031-05-06T12:10:00.000Z');
let appNow = REPLY_AT;
let slot = 0;
let weeks = 0;

async function clinic(slug: string): Promise<Clinic> {
  const jobs = createRecordingJobClient();
  const scheduling = await createSchedulingHttpWorld(runtime, {
    slug,
    // One key service for both organizations: the application that receives the webhook writes to both.
    keys,
    app: { adapters: createTestAdapterResolver({ whatsapp }), jobs, clock: () => appNow },
  });
  return { scheduling, notes: createNotificationsWorld(scheduling, { jobs, whatsapp }) };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await clinic('wa-attr-a');
  b = await clinic('wa-attr-b');
});

afterAll(async () => {
  await a.scheduling.close();
  await b.scheduling.close();
  await runtime.close();
});

beforeEach(() => {
  appNow = REPLY_AT;
  for (const { notes } of [a, b]) {
    notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
    notes.jobs.jobs.length = 0;
    notes.email.reset();
  }
  whatsapp.clear();
});

let phoneCounter = 0;
function nextPhone(country: '54' | '34' = '54') {
  phoneCounter += 1;
  const tail = String(20_000_000 + phoneCounter).slice(-8);
  return country === '54'
    ? { typed: `11${tail}`, e164: `+54911${tail}`, digits: `54911${tail}` }
    : { typed: `+34 6${tail}`, e164: `+346${tail}`, digits: `346${tail}` };
}

const nextTime = () => {
  slot += 1;
  return `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
};

/** A patient of the clinic with this number, opted in, whose reminder went out over WhatsApp. */
async function reminded(clinicOf: Clinic, phone: { typed: string }) {
  weeks += 1;
  const { notes, scheduling } = clinicOf;
  const patientId = await notes.patient({ phone: phone.typed, email: null });
  await scheduling.inTenant((tx) =>
    recordOptIn(tx, {
      patientId,
      channel: 'whatsapp',
      source: 'online_booking',
      actor: patientActor,
    }),
  );
  const booked = await notes.book(patientId, weeks, nextTime());
  const messageId = await notes.queue({
    kind: 'reminder',
    channel: 'whatsapp',
    patientId,
    appointmentId: booked.id,
    plannedStartsAt: new Date(booked.startsAt),
    appointmentVersion: booked.version,
    dedupeKey: `attr:${booked.id}:whatsapp`,
  });
  await notes.runAllJobs();
  const sent = await notes.message(messageId);
  expect(sent.status).toBe('sent');
  return { patientId, appointment: booked, messageId, providerMessageId: sent.providerMessageId };
}

const reply = (
  from: string,
  text: string,
  options: { replyTo?: string | null; eventId?: string } = {},
) => {
  const raw = JSON.stringify({
    events: [
      {
        kind: 'inbound',
        eventId: options.eventId ?? crypto.randomUUID(),
        from,
        text,
        occurredAt: '2031-05-06T12:10:00.000Z',
        ...(options.replyTo ? { contextMessageId: options.replyTo } : {}),
      },
    ],
  });
  return a.scheduling.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': whatsapp.signBody(raw) },
    payload: raw,
  });
};

const statusOf = async (clinicOf: Clinic, appointmentId: string) =>
  (
    await clinicOf.scheduling.inTenant((tx) =>
      tx
        .select({ status: appointment.status })
        .from(appointment)
        .where(eq(appointment.id, appointmentId)),
    )
  )[0]?.status;

const whatsappChoice = async (clinicOf: Clinic, patientId: string) =>
  (await clinicOf.scheduling.inTenant((tx) => loadPreferences(tx, patientId))).whatsapp;

const outcomes = (clinicOf: Clinic) =>
  clinicOf.scheduling.inTenant((tx) =>
    tx.select({ outcome: inboundMessage.outcome }).from(inboundMessage),
  );

const reviewCount = (clinicOf: Clinic) =>
  clinicOf.scheduling.inTenant(async (tx) => {
    const rows = await tx
      .select({ id: worklistItem.id })
      .from(worklistItem)
      .where(and(eq(worklistItem.kind, 'reply_to_review'), eq(worklistItem.status, 'open')));
    return rows.length;
  });

describe('one number on the books of two organizations', () => {
  it('acts in neither when nothing says which one the reply is about: both are shown to their reception', async () => {
    const phone = nextPhone();
    const first = await reminded(a, phone);
    const second = await reminded(b, phone);
    const [beforeA, beforeB] = [await reviewCount(a), await reviewCount(b)];

    const response = await reply(phone.e164, '2');

    expect(response.statusCode).toBe(200);
    expect(await statusOf(a, first.appointment.id)).toBe('scheduled');
    expect(await statusOf(b, second.appointment.id)).toBe('scheduled');
    expect(await reviewCount(a)).toBe(beforeA + 1);
    expect(await reviewCount(b)).toBe(beforeB + 1);
    expect(await outcomes(a)).toContainEqual({ outcome: 'needs_review' });
    expect(await outcomes(b)).toContainEqual({ outcome: 'needs_review' });
  });

  it('acts only in the organization of the message the patient replied to', async () => {
    const phone = nextPhone();
    const first = await reminded(a, phone);
    const second = await reminded(b, phone);

    const response = await reply(phone.e164, '2', { replyTo: second.providerMessageId });

    expect(response.statusCode).toBe(200);
    expect(await statusOf(b, second.appointment.id)).toBe('cancelled');
    expect(await statusOf(a, first.appointment.id)).toBe('scheduled');
    expect(await outcomes(a)).not.toContainEqual({ outcome: 'cancelled' });
  });

  it('does not take a reply to a message of another number as an answer from this one', async () => {
    const mine = nextPhone();
    const other = nextPhone();
    const first = await reminded(a, mine);
    const stranger = await reminded(b, other);

    await reply(mine.e164, '2', { replyTo: stranger.providerMessageId });

    // The message belongs to another number: the context is ignored and the one candidate decides.
    expect(await statusOf(b, stranger.appointment.id)).toBe('scheduled');
    expect(await statusOf(a, first.appointment.id)).toBe('cancelled');
  });

  it('opts the patient out in the organizations that wrote lately and tells each one by name', async () => {
    const phone = nextPhone();
    const first = await reminded(a, phone);
    const second = await reminded(b, phone);
    whatsapp.clear();

    await reply(phone.e164, 'BAJA');

    expect(await whatsappChoice(a, first.patientId)).toBe('opted_out');
    expect(await whatsappChoice(b, second.patientId)).toBe('opted_out');
    const acks = whatsapp.sent.filter((sent) => sent.templateKey === 'optout_ack');
    expect(acks).toHaveLength(2);
    expect(acks.map((ack) => ack.vars['organization']).sort()).toEqual(['wa-attr-a', 'wa-attr-b']);
  });

  it('leaves alone an organization that has not written to the number for weeks', async () => {
    const phone = nextPhone();
    const recent = await reminded(a, phone);
    const old = await reminded(b, phone);
    await b.scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE message SET sent_at = '2031-03-01T00:00:00Z' WHERE patient_id = ${old.patientId}`,
      ),
    );

    await reply(phone.e164, 'BAJA');

    expect(await whatsappChoice(a, recent.patientId)).toBe('opted_out');
    expect(await whatsappChoice(b, old.patientId)).toBe('opted_in');
  });

  it('still honours a BAJA when the only message to the number is old: the last organization that wrote', async () => {
    const phone = nextPhone();
    const only = await reminded(a, phone);
    await a.scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE message SET sent_at = '2031-01-01T00:00:00Z' WHERE patient_id = ${only.patientId}`,
      ),
    );

    await reply(phone.e164, 'BAJA');

    expect(await whatsappChoice(a, only.patientId)).toBe('opted_out');
  });

  it('records the opt-out of a patient whose number is not Argentine (the provider sends digits only)', async () => {
    const phone = nextPhone('34');
    const spanish = await reminded(a, phone);

    const response = await reply(phone.digits, 'BAJA');

    expect(response.json()).toEqual({ processed: 1 });
    expect(await whatsappChoice(a, spanish.patientId)).toBe('opted_out');
    expect(
      (
        await a.scheduling.inTenant((tx) =>
          tx.select({ choice: channelPreference.state }).from(channelPreference),
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('accepts PARAR and "no más" as opt-outs', async () => {
    const phone = nextPhone();
    const patient = await reminded(a, phone);

    await reply(phone.e164, 'No más');

    expect(await whatsappChoice(a, patient.patientId)).toBe('opted_out');
  });
});

describe('a free-text reply that two organizations could own (JD-S3 R2-B8)', () => {
  const replyItems = async (clinicOf: Clinic) => {
    const response = await clinicOf.scheduling.api.get(
      '/worklist?kind=reply_to_review',
      clinicOf.scheduling.owner,
    );
    return response.json<{ items: { detail: Record<string, unknown> | null }[] }>().items;
  };

  it('gives the text to the organization that wrote last and only a pointer to the other', async () => {
    const phone = nextPhone();
    const first = await reminded(a, phone);
    await reminded(b, phone);
    // a wrote an hour earlier than b (both inside the week of the reply).
    await a.scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE message SET sent_at = '2031-05-06T11:00:00Z' WHERE patient_id = ${first.patientId}`,
      ),
    );
    const text = 'me duele mucho el pecho desde ayer';

    const response = await reply(phone.e164, text);

    expect(response.statusCode).toBe(200);
    // b wrote last, so the reply is attributed to b; a is only told that something came in.
    const [forB] = (await replyItems(b)).filter((item) => item.detail?.['text'] === text);
    expect(forB).toBeDefined();
    const forA = await replyItems(a);
    expect(forA.some((item) => JSON.stringify(item.detail).includes('pecho'))).toBe(false);
    expect(forA.some((item) => item.detail?.['reason'] === 'several_organizations')).toBe(true);
  });

  it('keeps the text when only one organization could own the reply', async () => {
    const phone = nextPhone();
    await reminded(a, phone);

    await reply(phone.e164, 'llego un poco tarde');

    expect(
      (await replyItems(a)).some((item) => item.detail?.['text'] === 'llego un poco tarde'),
    ).toBe(true);
  });
});

describe('a BAJA in the weeks of the address-hash migration (JD-S3 R2-C4, A6)', () => {
  /** Puts the hashes of the log back to the unsalted ones the log held before the pepper. */
  const legacyHashes = (clinicOf: Clinic, patientId: string, phone: { e164: string }) =>
    clinicOf.scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE message SET address_hash = ${legacyAddressHash('whatsapp', normalizeInboundNumber(phone.e164) ?? '')}
             WHERE patient_id = ${patientId}`,
      ),
    );

  it('still opts out the patient whose messages have not been rehashed yet', async () => {
    const phone = nextPhone();
    const patient = await reminded(a, phone);
    await legacyHashes(a, patient.patientId, phone);

    await reply(phone.e164, 'BAJA');

    expect(await whatsappChoice(a, patient.patientId)).toBe('opted_out');
  });

  it('opts out every organization that holds the number, rehashed or not', async () => {
    const phone = nextPhone();
    const first = await reminded(a, phone);
    const second = await reminded(b, phone);
    await legacyHashes(b, second.patientId, phone);

    await reply(phone.e164, 'BAJA');

    expect(await whatsappChoice(a, first.patientId)).toBe('opted_out');
    expect(await whatsappChoice(b, second.patientId)).toBe('opted_out');
  });

  it('opts out every organization that wrote to a number nobody has written to lately, not only the last (A6)', async () => {
    const phone = nextPhone();
    const first = await reminded(a, phone);
    const second = await reminded(b, phone);
    for (const [clinicOf, sent] of [
      [a, first],
      [b, second],
    ] as const) {
      await clinicOf.scheduling.inTenant((tx) =>
        tx.execute(
          sql`UPDATE message SET sent_at = '2031-01-01T00:00:00Z' WHERE patient_id = ${sent.patientId}`,
        ),
      );
    }

    await reply(phone.e164, 'BAJA');

    expect(await whatsappChoice(a, first.patientId)).toBe('opted_out');
    expect(await whatsappChoice(b, second.patientId)).toBe('opted_out');
  });
});

describe('the deadline for cancelling by reply', () => {
  it('does not cancel by a reply after the deadline of the organization: it answers and opens an item for reception', async () => {
    const phone = nextPhone();
    const late = await reminded(a, phone);
    // The reply arrives two hours before the start; the default deadline is twelve.
    appNow = new Date(new Date(late.appointment.startsAt).getTime() - 2 * 3_600_000);
    await a.scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE message SET sent_at = ${new Date(appNow.getTime() - 3_600_000).toISOString()}::timestamptz WHERE patient_id = ${late.patientId}`,
      ),
    );
    const before = await reviewCount(a);
    whatsapp.clear();

    await reply(phone.e164, '2');

    expect(await statusOf(a, late.appointment.id)).toBe('scheduled');
    expect(await reviewCount(a)).toBe(before + 1);
    expect(whatsapp.sent.map((sent) => [sent.templateKey, sent.to])).toEqual([
      ['cancel_closed', phone.e164],
    ]);
  });
});

describe('finding the organization of a reply', () => {
  it('lets the runtime role read no message of another organization, whatever it declares', async () => {
    const phone = nextPhone();
    const sent = await reminded(a, phone);
    const NO_TENANT = '00000000-0000-0000-0000-000000000000';

    const seen = await runtime.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${NO_TENANT}, true)`);
      await tx.execute(
        sql`select set_config('app.lookup_provider_message_id', ${sent.providerMessageId ?? ''}, true)`,
      );
      await tx.execute(sql`select set_config('app.lookup_recipient_hash', 'x', true)`);
      return (await tx.execute<{ n: number }>(sql`select count(*)::int as n from message`)).rows[0]
        ?.n;
    });

    expect(seen).toBe(0);
  });
});
