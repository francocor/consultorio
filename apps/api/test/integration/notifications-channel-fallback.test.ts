import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { message } from '../../src/db/schema/notifications.js';
import { optOutChannel } from '../../src/modules/notifications/application/opt-out.js';
import {
  recordOptIn,
  recordOptOut as recordOptOutOnly,
} from '../../src/modules/notifications/application/preferences.js';
import { bindOfferDelivery } from '../../src/modules/notifications/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * When a patient opts out of WhatsApp, the reminders queued on WhatsApp are cancelled at once
 * (spec "Opt-out and consent") and, if the patient has an email that is not opted out, an email
 * reminder takes their place (decision D10: an opt-out is per channel, the other channel stays
 * permitted; spec "Delivery tracking, retries and fallback": a permitted channel carries it).
 */

const actor = { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null };

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let whatsapp: ReturnType<typeof createFakeWhatsAppSender>;
let week = 800;
let mobiles = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'notif-fallback' });
  whatsapp = createFakeWhatsAppSender();
  notes = createNotificationsWorld(scheduling, { whatsapp });
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(() => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.jobs.jobs.length = 0;
  notes.email.reset();
  whatsapp.clear();
  bindOfferDelivery({
    jobs: notes.jobs,
    clock: () => notes.now(),
    whatsappAvailable: () => true,
  });
});

const mobile = () => `+54911555${String(10_000 + ++mobiles).slice(1)}`;

/** An appointment with a WhatsApp reminder queued for tomorrow, and a patient who opted in. */
async function withWhatsAppReminder(contact: { email: string | null }) {
  week += 1;
  const patientId = await notes.patient({ email: contact.email, phone: mobile() });
  await scheduling.inTenant((tx) =>
    recordOptIn(tx, { patientId, channel: 'whatsapp', source: 'online_booking', actor }),
  );
  const appointment = await notes.book(patientId, week);
  const sendAt = new Date(new Date(appointment.startsAt).getTime() - 24 * 3_600_000);
  const groupKey = `reminder:${appointment.id}:v${String(appointment.version)}:l24`;
  const id = await notes.queue({
    kind: 'reminder',
    channel: 'whatsapp',
    patientId,
    appointmentId: appointment.id,
    plannedStartsAt: new Date(appointment.startsAt),
    appointmentVersion: appointment.version,
    sendAt,
    dedupeKey: `${groupKey}:whatsapp`,
  });
  return { patientId, appointment, id, sendAt, groupKey };
}

const optOut = (patientId: string, channel: 'email' | 'whatsapp') =>
  scheduling.inTenant((tx) =>
    optOutChannel(tx, { patientId, channel, source: 'whatsapp_keyword', actor }),
  );

const log = (appointmentId: string) =>
  scheduling.inTenant((tx) =>
    tx.select().from(message).where(eq(message.appointmentId, appointmentId)),
  );

describe('an opt-out of WhatsApp', () => {
  it('cancels the queued WhatsApp reminder and queues an email one for the same moment', async () => {
    const r = await withWhatsAppReminder({ email: 'respaldo@example.test' });

    const result = await optOut(r.patientId, 'whatsapp');

    expect(result).toMatchObject({ recorded: true, cancelled: 1, replaced: 1 });
    const rows = await log(r.appointment.id);
    expect(
      rows.map((row) => `${row.channel}:${row.status}:${row.cancelReason ?? ''}`).sort(),
    ).toEqual(['email:queued:', 'whatsapp:cancelled:opted_out']);
    const email = rows.find((row) => row.channel === 'email');
    expect(email).toMatchObject({ kind: 'reminder', dedupeKey: `${r.groupKey}:email` });
    expect(email?.sendAt).toEqual(r.sendAt);
  });

  it('delivers the email reminder when its time comes, and nothing on WhatsApp', async () => {
    const r = await withWhatsAppReminder({ email: 'llega@example.test' });
    await optOut(r.patientId, 'whatsapp');
    notes.setNow(new Date(r.sendAt.getTime() + 60_000));

    await notes.runAllJobs();

    expect(notes.email.sent.map((mail) => mail.to)).toEqual(['llega@example.test']);
    expect(whatsapp.sent).toHaveLength(0);
  });

  it('does not queue an email when the patient has none, and the sweep will tell reception', async () => {
    const r = await withWhatsAppReminder({ email: null });

    const result = await optOut(r.patientId, 'whatsapp');

    expect(result).toMatchObject({ recorded: true, cancelled: 1, replaced: 0 });
    expect((await log(r.appointment.id)).map((row) => row.channel)).toEqual(['whatsapp']);
  });

  it('does not queue an email for a patient who opted out of email as well', async () => {
    const r = await withWhatsAppReminder({ email: 'ninguno@example.test' });
    await scheduling.inTenant((tx) =>
      recordOptOutOnly(tx, {
        patientId: r.patientId,
        channel: 'email',
        source: 'email_link',
        actor,
      }),
    );

    const result = await optOut(r.patientId, 'whatsapp');

    expect(result).toMatchObject({ cancelled: 1, replaced: 0 });
    expect((await log(r.appointment.id)).filter((row) => row.status === 'queued')).toEqual([]);
  });

  it('does not queue a second email when one already exists for that reminder', async () => {
    const r = await withWhatsAppReminder({ email: 'ya@example.test' });
    await notes.queue({
      kind: 'reminder',
      channel: 'email',
      patientId: r.patientId,
      appointmentId: r.appointment.id,
      plannedStartsAt: new Date(r.appointment.startsAt),
      appointmentVersion: r.appointment.version,
      sendAt: r.sendAt,
      dedupeKey: `${r.groupKey}:email`,
    });

    const result = await optOut(r.patientId, 'whatsapp');

    expect(result.replaced).toBe(0);
    expect((await log(r.appointment.id)).filter((row) => row.channel === 'email')).toHaveLength(1);
  });

  it('is idempotent: opting out again changes nothing', async () => {
    const r = await withWhatsAppReminder({ email: 'dos@example.test' });
    await optOut(r.patientId, 'whatsapp');

    const again = await optOut(r.patientId, 'whatsapp');

    expect(again).toMatchObject({ recorded: false, cancelled: 0, replaced: 0 });
    expect(await log(r.appointment.id)).toHaveLength(2);
  });

  it('leaves a confirmation of the appointment that was queued on WhatsApp to email as well', async () => {
    const r = await withWhatsAppReminder({ email: 'conf@example.test' });
    const confirmation = await notes.queue({
      kind: 'confirmation',
      channel: 'whatsapp',
      patientId: r.patientId,
      appointmentId: r.appointment.id,
      plannedStartsAt: new Date(r.appointment.startsAt),
      appointmentVersion: r.appointment.version,
      sendAt: notes.now(),
      dedupeKey: `confirmation:${r.appointment.id}:v${String(r.appointment.version)}:whatsapp`,
    });

    await optOut(r.patientId, 'whatsapp');

    const rows = await log(r.appointment.id);
    expect(rows.find((row) => row.id === confirmation)?.status).toBe('cancelled');
    expect(
      rows.filter((row) => row.kind === 'confirmation' && row.channel === 'email'),
    ).toHaveLength(1);
  });
});

describe('an opt-out of email', () => {
  it('moves a queued email reminder to WhatsApp when the patient opted in to it', async () => {
    week += 1;
    const patientId = await notes.patient({ email: 'x@example.test', phone: mobile() });
    const appointment = await notes.book(patientId, week);
    const sendAt = new Date(new Date(appointment.startsAt).getTime() - 24 * 3_600_000);
    const groupKey = `reminder:${appointment.id}:v${String(appointment.version)}:l24`;
    await notes.queue({
      kind: 'reminder',
      channel: 'email',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      sendAt,
      dedupeKey: `${groupKey}:email`,
    });
    // The patient opts in to WhatsApp afterwards, then opts out of email.
    await scheduling.inTenant((tx) =>
      recordOptIn(tx, { patientId, channel: 'whatsapp', source: 'patient_email_link', actor }),
    );

    const result = await scheduling.inTenant((tx) =>
      optOutChannel(tx, { patientId, channel: 'email', source: 'email_link', actor }),
    );

    expect(result).toMatchObject({ cancelled: 1, replaced: 1 });
    const rows = await log(appointment.id);
    expect(rows.find((row) => row.channel === 'whatsapp')).toMatchObject({
      status: 'queued',
      dedupeKey: `${groupKey}:whatsapp`,
    });
  });
});
