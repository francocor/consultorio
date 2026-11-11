import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { channelPreference } from '../../src/db/schema/channel-preference.js';
import { inboundMessage, message } from '../../src/db/schema/notifications.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import {
  loadPreferences,
  recordOptIn,
} from '../../src/modules/notifications/application/preferences.js';
import type { AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { createTestAdapterResolver } from '../support/adapters.js';
import { BASE_DOMAIN } from '../support/app.js';
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

  it('opts the patient out of email too (B7) and cancels what was queued on email', async () => {
    const r = await reminded();
    const email = await notes.queue({
      kind: 'reminder',
      channel: 'email',
      patientId: r.patientId,
      appointmentId: r.appointment.id,
      plannedStartsAt: new Date(r.appointment.startsAt),
      appointmentVersion: r.appointment.version,
      dedupeKey: `in:${r.appointment.id}:email`,
    });

    await reply(r.phone.e164, 'BAJA');

    expect(await inForce(r.patientId)).toEqual({ email: 'opted_out', whatsapp: 'opted_out' });
    expect(await notes.message(email)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
  });

  it('revokes a link to accept WhatsApp that was still pending, so it cannot undo the BAJA (D22 stays)', async () => {
    const r = await reminded();
    const tokens = createActionTokens({ clock: () => notes.now() });
    // The link of a public form belongs to the submission and remembers the patient.
    const pending = await scheduling.inTenant((tx) =>
      tokens.issue(tx, {
        kind: 'whatsapp_opt_in',
        subjectId: crypto.randomUUID(),
        payload: { patientId: r.patientId, created: true },
      }),
    );

    await reply(r.phone.e164, 'BAJA');

    const followed = await scheduling.app.inject({
      method: 'POST',
      url: `/public/t/${pending.token}`,
      headers: {
        host: `${scheduling.slug}.${BASE_DOMAIN}`,
        origin: `https://${scheduling.slug}.${BASE_DOMAIN}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'choice=accept',
    });
    expect(followed.statusCode).toBe(404);
    expect((await inForce(r.patientId)).whatsapp).toBe('opted_out');
    expect(await whatsappHistory(r.patientId)).toEqual([
      { state: 'opted_in', source: 'online_booking' },
      { state: 'opted_out', source: 'whatsapp_keyword' },
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

/**
 * Owner decision B7, refined: a BAJA from a number that several patients share (a family with one
 * phone) closes WhatsApp for everybody on that number, but the full opt-out (email too, every
 * pending message, every waitlist entry) is only for the patient the reply belongs to: the one
 * whose message it quotes, otherwise the one written to last, and when that cannot be told apart
 * nobody loses email and reception is asked to confirm.
 */
describe('BAJA from a number shared by several patients (B7)', () => {
  const HOUR = 3_600_000;
  let sharedWeek = 100;

  /** Two patients on one phone, each with an email, a sent WhatsApp reminder and one still queued. */
  async function family(options: { gapMs: number }) {
    const phone = nextPhone();
    // A week of their own, far from the ones the other tests book in.
    sharedWeek += 1;
    const week = sharedWeek;
    const member = async (name: string, sentAt: Date) => {
      const patientId = await notes.patient({ phone: phone.typed, email: `${name}@example.test` });
      await scheduling.inTenant((tx) =>
        recordOptIn(tx, {
          patientId,
          channel: 'whatsapp',
          source: 'online_booking',
          actor: patientActor,
        }),
      );
      const sent = await remindedPatient(patientId, phone, week);
      // Every message that already went to the number (the booking planned one of its own).
      await scheduling.inTenant((tx) =>
        tx.execute(
          sql`UPDATE message SET sent_at = ${sentAt} WHERE patient_id = ${patientId} AND sent_at IS NOT NULL`,
        ),
      );
      const providerMessageId = (await notes.message(sent.messageId)).providerMessageId;
      return { ...sent, providerMessageId };
    };
    /** Queued after both were reminded, so the jobs that sent the reminders leave them alone. */
    const withQueued = async (sent: Awaited<ReturnType<typeof member>>) => {
      const common = {
        patientId: sent.patientId,
        appointmentId: sent.appointment.id,
        plannedStartsAt: new Date(sent.appointment.startsAt),
        appointmentVersion: sent.appointment.version,
      };
      const pending = await notes.queue({
        kind: 'reminder',
        channel: 'whatsapp',
        ...common,
        dedupeKey: `shared:${sent.appointment.id}:whatsapp`,
      });
      const queuedEmail = await notes.queue({
        kind: 'reminder',
        channel: 'email',
        ...common,
        dedupeKey: `shared-other:${sent.appointment.id}:email`,
      });
      return { ...sent, pending, queuedEmail };
    };
    const earlier = new Date('2031-05-06T10:00:00.000Z');
    const reminded1 = await member('primero', earlier);
    const reminded2 = await member('segundo', new Date(earlier.getTime() + options.gapMs));
    const first = await withQueued(reminded1);
    const second = await withQueued(reminded2);
    whatsapp.clear();
    return { phone, first, second };
  }

  const replyWithContext = (from: string, contextMessageId?: string | null) => {
    const raw = JSON.stringify({
      events: [
        {
          kind: 'inbound',
          eventId: crypto.randomUUID(),
          from,
          text: 'BAJA',
          occurredAt: '2031-05-06T12:10:00.000Z',
          ...(contextMessageId ? { contextMessageId } : {}),
        },
      ],
    });
    return scheduling.app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': whatsapp.signBody(raw),
      },
      payload: raw,
    });
  };

  const emailRowsOf = (patientId: string) =>
    scheduling.inTenant((tx) =>
      tx
        .select({ status: message.status, kind: message.kind, dedupeKey: message.dedupeKey })
        .from(message)
        .where(and(eq(message.patientId, patientId), eq(message.channel, 'email'))),
    );

  const emailOptOutItems = async () => {
    const response = await scheduling.api.get('/worklist?kind=reply_to_review', scheduling.owner);
    return response
      .json<{ items: { detail: Record<string, unknown> | null }[] }>()
      .items.filter((item) => item.detail?.['reason'] === 'email_optout_unconfirmed');
  };

  it('gives the full opt-out to the patient of the quoted message, even if another was written to later', async () => {
    const { phone, first, second } = await family({ gapMs: 2 * HOUR });
    const before = (await emailOptOutItems()).length;

    const response = await replyWithContext(phone.e164, first.providerMessageId);

    expect(response.statusCode).toBe(200);
    // The owner of the reply: email and WhatsApp, and everything queued, cancelled.
    expect(await inForce(first.patientId)).toEqual({ email: 'opted_out', whatsapp: 'opted_out' });
    expect((await notes.message(first.pending)).status).toBe('cancelled');
    expect((await notes.message(first.queuedEmail)).status).toBe('cancelled');
    // The other member of the family: WhatsApp off, email untouched.
    expect(await inForce(second.patientId)).toEqual({ email: 'default', whatsapp: 'opted_out' });
    expect((await notes.message(second.queuedEmail)).status).toBe('queued');
    expect(await emailOptOutItems()).toHaveLength(before);
  });

  it('gives the full opt-out to the patient written to last when the reply quotes nothing', async () => {
    const { phone, first, second } = await family({ gapMs: 2 * HOUR });

    await replyWithContext(phone.e164);

    expect(await inForce(second.patientId)).toEqual({ email: 'opted_out', whatsapp: 'opted_out' });
    expect(await inForce(first.patientId)).toEqual({ email: 'default', whatsapp: 'opted_out' });
  });

  it('replaces the WhatsApp reminders of the other members by email, and keeps their email as it was', async () => {
    const { phone, first, second } = await family({ gapMs: 2 * HOUR });

    await replyWithContext(phone.e164);

    // The first member is not the owner: the pending WhatsApp reminder is cancelled and an email
    // one for the same appointment is queued in its place (the D10 fallback, for this case only).
    expect(await notes.message(first.pending)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
    const emails = await emailRowsOf(first.patientId);
    expect(emails.map((row) => `${row.status}:${row.dedupeKey}`)).toEqual(
      expect.arrayContaining([`queued:shared:${first.appointment.id}:email`]),
    );
    // The owner gets nothing in place of theirs.
    expect((await emailRowsOf(second.patientId)).filter((row) => row.status === 'queued')).toEqual(
      [],
    );
  });

  it('opts WhatsApp out for everybody and asks reception when the owner cannot be told (two written to at the same time)', async () => {
    const { phone, first, second } = await family({ gapMs: 30_000 });
    const before = (await emailOptOutItems()).length;

    await replyWithContext(phone.e164);

    for (const member of [first, second]) {
      expect(await inForce(member.patientId)).toEqual({ email: 'default', whatsapp: 'opted_out' });
      expect((await notes.message(member.pending)).status).toBe('cancelled');
      expect((await notes.message(member.queuedEmail)).status).toBe('queued');
    }
    const items = await emailOptOutItems();
    expect(items).toHaveLength(before + 1);
    expect(items.at(-1)?.detail?.['patientIds']).toEqual(
      expect.arrayContaining([first.patientId, second.patientId]),
    );
  });

  it('keeps the full opt-out for a number that belongs to one patient only', async () => {
    const r = await reminded();

    await replyWithContext(r.phone.e164);

    expect(await inForce(r.patientId)).toEqual({ email: 'opted_out', whatsapp: 'opted_out' });
  });

  it('answers the shared number once, saying WhatsApp stops for the number and email for who replied', async () => {
    const { phone } = await family({ gapMs: 2 * HOUR });

    await replyWithContext(phone.e164);

    expect(whatsapp.sent.map((sent) => [sent.templateKey, sent.to])).toEqual([
      ['optout_ack_shared', phone.e164],
    ]);
    expect(whatsapp.sent[0]?.vars['emailPending']).toBeUndefined();
  });

  it('answers that reception will confirm the email when the owner cannot be told', async () => {
    const { phone } = await family({ gapMs: 30_000 });

    await replyWithContext(phone.e164);

    expect(whatsapp.sent.map((sent) => sent.templateKey)).toEqual(['optout_ack_shared']);
    expect(whatsapp.sent[0]?.vars['emailPending']).toBe('yes');
  });

  it('answers a single-patient number with the usual acknowledgment', async () => {
    const r = await reminded();
    whatsapp.clear();

    await replyWithContext(r.phone.e164);

    expect(whatsapp.sent.map((sent) => sent.templateKey)).toEqual(['optout_ack']);
  });
});
