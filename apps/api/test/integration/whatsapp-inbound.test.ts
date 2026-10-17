import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { channelPreference } from '../../src/db/schema/channel-preference.js';
import { inboundMessage } from '../../src/db/schema/notifications.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import {
  loadPreferences,
  recordOptIn,
} from '../../src/modules/notifications/application/preferences.js';
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

/**
 * What a patient can do by replying on WhatsApp: opt out, confirm or cancel with the fixed replies,
 * and nothing else. Anything that is not clearly one patient's clear answer goes to reception.
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
let phoneCounter = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const jobs = createRecordingJobClient();
  scheduling = await createSchedulingHttpWorld(runtime, {
    slug: 'wa-inbound',
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
  whatsapp.clear();
  await notes.setTenant({ status: 'active' });
});

/** A distinct mobile number in the national form patients type, and the same number as E.164. */
function nextPhone() {
  phoneCounter += 1;
  const tail = String(10_000_000 + phoneCounter).slice(-8);
  return { typed: `11${tail}`, e164: `+54911${tail}` };
}

const nextTime = () => {
  slot += 1;
  return `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
};

/** A patient with a mobile number who opted in to WhatsApp and has no email. */
async function optedInPatient(phone: { typed: string }) {
  const patientId = await notes.patient({ phone: phone.typed, email: null });
  await scheduling.inTenant((tx) =>
    recordOptIn(tx, {
      patientId,
      channel: 'whatsapp',
      source: 'online_booking',
      actor: patientActor,
    }),
  );
  return patientId;
}

/** An opted-in patient with an appointment whose reminder went out over WhatsApp. */
async function reminded(phone = nextPhone(), week = 1 + Math.floor(slot / 8)) {
  return remindedPatient(await optedInPatient(phone), phone, week);
}

async function remindedPatient(patientId: string, phone: { e164: string }, week: number) {
  const booked = await notes.book(patientId, week, nextTime());
  const messageId = await notes.queue({
    kind: 'reminder',
    channel: 'whatsapp',
    patientId,
    appointmentId: booked.id,
    plannedStartsAt: new Date(booked.startsAt),
    appointmentVersion: booked.version,
    dedupeKey: `in:${booked.id}:whatsapp`,
  });
  await notes.runAllJobs();
  expect((await notes.message(messageId)).status).toBe('sent');
  return { patientId, appointment: booked, messageId, phone };
}

const reply = (from: string, text: string, eventId = crypto.randomUUID()) => {
  const raw = JSON.stringify({
    events: [{ kind: 'inbound', eventId, from, text, occurredAt: '2031-05-06T12:10:00.000Z' }],
  });
  return scheduling.app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': whatsapp.signBody(raw) },
    payload: raw,
  });
};

const statusOf = async (appointmentId: string) =>
  (
    await scheduling.inTenant((tx) =>
      tx
        .select({ status: appointment.status, cancelledBy: appointment.cancelledByKind })
        .from(appointment)
        .where(eq(appointment.id, appointmentId)),
    )
  )[0];

/** The choices in force of a patient, and the whole history of their WhatsApp choices. */
const inForce = (patientId: string) => scheduling.inTenant((tx) => loadPreferences(tx, patientId));
const whatsappHistory = (patientId: string) =>
  scheduling.inTenant((tx) =>
    tx
      .select({ state: channelPreference.state, source: channelPreference.source })
      .from(channelPreference)
      .where(
        and(eq(channelPreference.patientId, patientId), eq(channelPreference.channel, 'whatsapp')),
      )
      .orderBy(channelPreference.createdAt, channelPreference.id),
  );

const reviewItems = () =>
  scheduling.inTenant((tx) =>
    tx
      .select({
        kind: worklistItem.kind,
        subjectType: worklistItem.subjectType,
        status: worklistItem.status,
      })
      .from(worklistItem)
      .where(and(eq(worklistItem.kind, 'reply_to_review'), eq(worklistItem.status, 'open'))),
  );

describe('BAJA and STOP', () => {
  it('opts the patient out of WhatsApp, cancels what is queued and answers with one acknowledgment', async () => {
    const r = await reminded();
    const pending = await notes.queue({
      kind: 'reminder',
      channel: 'whatsapp',
      patientId: r.patientId,
      appointmentId: r.appointment.id,
      plannedStartsAt: new Date(r.appointment.startsAt),
      appointmentVersion: r.appointment.version,
      dedupeKey: `in:${r.appointment.id}:second:whatsapp`,
    });
    notes.jobs.jobs.length = 0;
    whatsapp.clear();

    const response = await reply(r.phone.e164, 'BAJA');

    expect(response.statusCode).toBe(200);
    expect(await whatsappHistory(r.patientId)).toEqual([
      { state: 'opted_in', source: 'online_booking' },
      { state: 'opted_out', source: 'whatsapp_keyword' },
    ]);
    expect(await notes.message(pending)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
    expect(whatsapp.sent.map((sent) => [sent.templateKey, sent.to])).toEqual([
      ['optout_ack', r.phone.e164],
    ]);
  });

  it('accepts STOP in any case, with the marks people add', async () => {
    const r = await reminded();

    await reply(r.phone.e164, ' stop. ');

    expect((await inForce(r.patientId)).whatsapp).toBe('opted_out');
  });

  it('acknowledges once even if the same reply is delivered twice', async () => {
    const r = await reminded();
    whatsapp.clear();
    const eventId = crypto.randomUUID();

    await reply(r.phone.e164, 'BAJA', eventId);
    const again = await reply(r.phone.e164, 'BAJA', eventId);

    expect(again.json()).toEqual({ processed: 0 });
    expect(whatsapp.sent.filter((sent) => sent.templateKey === 'optout_ack')).toHaveLength(1);
    expect(await whatsappHistory(r.patientId)).toHaveLength(2);
  });

  it('opts out every patient the number was written about: it cannot tell who replied', async () => {
    const phone = nextPhone();
    const first = await reminded(phone);
    const second = await remindedPatient(await optedInPatient(phone), phone, 3);

    await reply(phone.e164, 'BAJA');

    expect((await inForce(first.patientId)).whatsapp).toBe('opted_out');
    expect((await inForce(second.patientId)).whatsapp).toBe('opted_out');
  });
});

describe('the fixed replies 1 and 2', () => {
  it('confirms the one outstanding appointment with a 1', async () => {
    const r = await reminded();

    await reply(r.phone.e164, '1');

    expect(await statusOf(r.appointment.id)).toMatchObject({ status: 'confirmed' });
    expect(
      await scheduling.inTenant((tx) =>
        tx.select({ outcome: inboundMessage.outcome }).from(inboundMessage),
      ),
    ).toContainEqual({ outcome: 'confirmed' });
  });

  it('cancels it as cancelled by the patient with a 2', async () => {
    const r = await reminded();

    await reply(r.phone.e164, '2');

    expect(await statusOf(r.appointment.id)).toEqual({
      status: 'cancelled',
      cancelledBy: 'patient',
    });
  });

  it('applies a reply once, however many times it is delivered', async () => {
    const r = await reminded();
    const eventId = crypto.randomUUID();

    await reply(r.phone.e164, '1', eventId);
    const again = await reply(r.phone.e164, '1', eventId);

    expect(again.json()).toEqual({ processed: 0 });
    expect(await statusOf(r.appointment.id)).toMatchObject({ status: 'confirmed' });
  });

  it('changes nothing when two patients share the number and both have an outstanding reminder', async () => {
    const phone = nextPhone();
    const first = await reminded(phone);
    const second = await remindedPatient(await optedInPatient(phone), phone, 4);

    await reply(phone.e164, '1');

    expect((await statusOf(first.appointment.id))?.status).toBe('scheduled');
    expect((await statusOf(second.appointment.id))?.status).toBe('scheduled');
    expect(await reviewItems()).toContainEqual({
      kind: 'reply_to_review',
      subjectType: 'inbound_message',
      status: 'open',
    });
  });

  it('changes nothing when nothing is outstanding any more: an old reminder is history', async () => {
    const r = await reminded();
    // Every message of the appointment (the booking planned one of its own) was sent long ago.
    await scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE message SET sent_at = '2000-01-01T00:00:00Z' WHERE appointment_id = ${r.appointment.id}`,
      ),
    );

    await reply(r.phone.e164, '1');

    expect((await statusOf(r.appointment.id))?.status).toBe('scheduled');
  });
});

describe('everything else', () => {
  it('leaves the appointment alone and shows the reply to reception ("maybe tomorrow")', async () => {
    const r = await reminded();
    const before = (await reviewItems()).length;

    await reply(r.phone.e164, 'maybe tomorrow');

    expect((await statusOf(r.appointment.id))?.status).toBe('scheduled');
    expect((await reviewItems()).length).toBe(before + 1);
  });

  it('does not record an opt-in for a "SI": a reply never opts anybody in', async () => {
    const r = await reminded();
    await reply(r.phone.e164, 'BAJA');
    const afterOptOut = await whatsappHistory(r.patientId);

    await reply(r.phone.e164, 'SI');

    expect(await whatsappHistory(r.patientId)).toEqual(afterOptOut);
    expect((await inForce(r.patientId)).whatsapp).toBe('opted_out');
  });

  it('writes nothing for a "SI" from a number the organization never wrote to', async () => {
    const stranger = nextPhone();
    const before = await scheduling.inTenant((tx) => tx.select().from(channelPreference));

    const response = await reply(stranger.e164, 'SI');

    expect(response.json()).toEqual({ processed: 0 });
    expect(await scheduling.inTenant((tx) => tx.select().from(channelPreference))).toHaveLength(
      before.length,
    );
  });
});

describe('in a read-only organization', () => {
  it('lets the patient cancel and opt out, but does not confirm, and sends no acknowledgment', async () => {
    const confirm = await reminded();
    const cancel = await reminded();
    const optOut = await reminded();
    await notes.setTenant({ status: 'read_only' });
    whatsapp.clear();

    await reply(confirm.phone.e164, '1');
    await reply(cancel.phone.e164, '2');
    await reply(optOut.phone.e164, 'BAJA');

    expect((await statusOf(confirm.appointment.id))?.status).toBe('scheduled');
    expect((await statusOf(cancel.appointment.id))?.status).toBe('cancelled');
    expect((await inForce(optOut.patientId)).whatsapp).toBe('opted_out');
    expect(whatsapp.sent).toEqual([]);
  });
});
