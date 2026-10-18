import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { channelPreference } from '../../src/db/schema/channel-preference.js';
import { message, messageAttempt } from '../../src/db/schema/notifications.js';
import { recordOptOut } from '../../src/modules/notifications/application/preferences.js';
import { createBookingNotifier } from '../../src/modules/notifications/index.js';
import type { BookingNotice } from '../../src/modules/online-booking/index.js';
import { composeBookingConfirmation } from '../../src/modules/online-booking/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createPublicOrigins } from '../../src/platform/http/public-origin.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { BASE_DOMAIN } from '../support/app.js';
import { insertAppointmentRow, insertPatient } from '../support/fixture-helpers.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * The confirmation of an online booking goes out through notifications: logged on the appointment,
 * to the address the visitor verified (not the one on the record), once, whatever the hour, and not
 * to a patient who opted out of email. The WhatsApp choice of the form is recorded as an opt-in.
 */

const actor = { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null };

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let waits: number[];
let week = 700;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'notif-booking' });
  notes = createNotificationsWorld(scheduling);
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(() => {
  notes.setNow(new Date('2031-05-06T15:00:00.000Z'));
  notes.email.reset();
  waits = [];
});

const origins = createPublicOrigins({ mode: 'multi', baseDomain: BASE_DOMAIN }, { secure: true });

const notifier = () =>
  createBookingNotifier({
    withTenant: createWithTenant(runtime.db),
    email: notes.email,
    clock: () => notes.now(),
    tokens: createActionTokens({ clock: () => notes.now() }),
    compose: (notice) => composeBookingConfirmation(origins, notice),
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });

/** A booking of a patient whose record has another email than the one the visitor verified. */
async function booking(options: { recordEmail?: string | null } = {}) {
  week += 1;
  const patientId = await notes.patient({
    email: options.recordEmail === undefined ? 'registro@example.test' : options.recordEmail,
  });
  const appointment = await scheduling.book(week, '10:00', { patientId });
  const notice: BookingNotice = {
    tenant: { id: scheduling.tenant.id, slug: scheduling.slug, isDemo: false },
    to: 'verificado@example.test',
    organizationName: 'Consultorio Prueba',
    professionalName: 'Dra. Prueba',
    locationName: 'Centro',
    startsAt: new Date(appointment.startsAt),
    timeZone: 'America/Argentina/Buenos_Aires',
    pendingApproval: false,
    manageToken: 'MANAGE-TOKEN',
    whatsappOptInToken: null,
    patientId,
    appointmentId: appointment.id,
  };
  return { patientId, appointment, notice };
}

const logOf = (appointmentId: string) =>
  scheduling.inTenant((tx) =>
    tx.select().from(message).where(eq(message.appointmentId, appointmentId)),
  );

describe('the confirmation of an online booking', () => {
  it('goes to the address the visitor verified, with the link to change it, and is logged as sent', async () => {
    const { notice, appointment } = await booking();

    await notifier().confirmBooking(notice);

    expect(notes.email.sent).toHaveLength(1);
    const sent = notes.email.sent[0];
    expect(sent?.to).toBe('verificado@example.test');
    expect(sent?.subject).toMatch(/confirmado|solicitud/i);
    expect(sent?.text).toContain('/book/manage/MANAGE-TOKEN');
    const [logged] = await logOf(appointment.id);
    expect(logged).toMatchObject({
      kind: 'confirmation',
      channel: 'email',
      status: 'sent',
      attempts: 1,
      appointmentId: appointment.id,
    });
    // The log keeps a hash of the address, never the address.
    expect(JSON.stringify(logged)).not.toContain('verificado');
  });

  it('is sent at night as well: it answers an action of the patient', async () => {
    const { notice } = await booking();
    notes.setNow(new Date('2031-05-07T02:00:00.000Z'));

    await notifier().confirmBooking(notice);

    expect(notes.email.sent).toHaveLength(1);
  });

  it('is sent once, however many times it is asked for the same booking', async () => {
    const { notice, appointment } = await booking();

    await notifier().confirmBooking(notice);
    await notifier().confirmBooking(notice);

    expect(notes.email.sent).toHaveLength(1);
    expect(await logOf(appointment.id)).toHaveLength(1);
  });

  it('is sent again when the patient moves the appointment: it is another time', async () => {
    const { notice, appointment } = await booking();
    await notifier().confirmBooking(notice);

    await notifier().confirmBooking({
      ...notice,
      startsAt: new Date(notice.startsAt.getTime() + 3_600_000),
    });

    expect(notes.email.sent).toHaveLength(2);
    expect(await logOf(appointment.id)).toHaveLength(2);
  });

  it('is sent to the verified address even when the record of the patient opted out of email (JD-S3 C2)', async () => {
    // The address belongs to the visitor, who just proved it with a code: the answer to their
    // action is service communication, and an opt-out of somebody else's record must not decide
    // whether it is sent (it would tell the visitor that the document exists).
    const { notice, appointment, patientId } = await booking();
    await scheduling.inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor }),
    );

    await notifier().confirmBooking(notice);

    expect(notes.email.sent.map((mail) => mail.to)).toEqual(['verificado@example.test']);
    expect(await logOf(appointment.id)).toMatchObject([{ status: 'sent' }]);
  });

  it('is not sent for a demonstration organization, and the log says so (JD-S3 B13)', async () => {
    const demo = await createTestTenant(runtime, { slug: 'notif-booking-demo', isDemo: true });
    const notice = await asTenant(runtime, demo.id, async (tx) => {
      const patientId = await insertPatient(tx, demo.id);
      const appointmentId = await insertAppointmentRow(tx, demo.id, { patient_id: patientId });
      return {
        patientId,
        appointmentId,
      };
    });

    await notifier().confirmBooking({
      tenant: { id: demo.id, slug: 'notif-booking-demo', isDemo: true },
      to: 'visitante@example.test',
      organizationName: 'Demo',
      professionalName: 'Dra. Demo',
      locationName: 'Centro',
      startsAt: new Date('2031-09-01T13:00:00.000Z'),
      timeZone: 'America/Argentina/Buenos_Aires',
      pendingApproval: false,
      manageToken: null,
      whatsappOptInToken: null,
      patientId: notice.patientId,
      appointmentId: notice.appointmentId,
    });

    const rows = await asTenant(runtime, demo.id, (tx) =>
      tx.select().from(message).where(eq(message.appointmentId, notice.appointmentId)),
    );
    expect(rows).toMatchObject([{ status: 'cancelled', cancelReason: 'demo_tenant' }]);
  });

  it('tries again after a temporary failure and records every attempt', async () => {
    const { notice, appointment } = await booking();
    notes.email.script = [new Error('connection lost'), 'ok'];

    await notifier().confirmBooking(notice);

    expect(notes.email.sent).toHaveLength(1);
    expect(waits).toHaveLength(1);
    const [logged] = await logOf(appointment.id);
    expect(logged).toMatchObject({ status: 'sent', attempts: 2 });
    const attempts = await scheduling.inTenant((tx) =>
      tx
        .select()
        .from(messageAttempt)
        .where(eq(messageAttempt.messageId, logged?.id ?? '')),
    );
    expect(attempts.map((row) => row.outcome).sort()).toEqual(['accepted', 'retryable']);
  });

  it('gives up after three attempts without failing the booking, and logs it', async () => {
    const { notice, appointment } = await booking();
    notes.email.script = [new Error('down'), new Error('down'), new Error('down')];

    await expect(notifier().confirmBooking(notice)).resolves.toBeUndefined();

    expect(notes.email.sent).toHaveLength(0);
    expect(await logOf(appointment.id)).toMatchObject([
      { status: 'failed', failureReason: 'retries_exhausted', attempts: 3 },
    ]);
  });

  it('does not try again an address the mailbox refused for good', async () => {
    const { notice, appointment } = await booking();
    notes.email.script = [{ responseCode: 550 }];

    await notifier().confirmBooking(notice);

    expect(notes.email.calls).toBe(1);
    expect(await logOf(appointment.id)).toMatchObject([
      { status: 'failed', failureReason: 'mailbox_unavailable' },
    ]);
  });
});

describe('the WhatsApp choice of the booking form (JD-S3 D22)', () => {
  it('is a request: no opt-in is recorded until the patient follows the link in the confirmation', async () => {
    const { notice, appointment, patientId } = await booking();
    const notify = notifier();

    const requested = await scheduling.inTenant(
      async (tx) =>
        (await notify.requestWhatsAppOptIn?.(tx, { patientId, at: notes.now() })) ?? null,
    );

    expect(requested?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const before = await scheduling.inTenant((tx) =>
      tx.select().from(channelPreference).where(eq(channelPreference.patientId, patientId)),
    );
    expect(before).toEqual([]);

    await notify.confirmBooking({ ...notice, whatsappOptInToken: requested?.token ?? null });

    // The link travels in the confirmation, to the address the visitor verified, and nowhere else.
    expect(notes.email.sent).toHaveLength(1);
    expect(notes.email.sent[0]?.to).toBe('verificado@example.test');
    expect(notes.email.sent[0]?.text).toContain(`/public/t/${requested?.token ?? ''}`);
    expect(await logOf(appointment.id)).toMatchObject([{ status: 'sent' }]);
    // Following it is what records the opt-in, and the first WhatsApp message may go after that.
    const page = await scheduling.app.inject({
      method: 'POST',
      url: `/public/t/${requested?.token ?? ''}`,
      headers: {
        host: `${scheduling.slug}.${BASE_DOMAIN}`,
        origin: `https://${scheduling.slug}.${BASE_DOMAIN}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'choice=accept',
    });
    expect(page.statusCode, page.body).toBe(200);
    const after = await scheduling.inTenant((tx) =>
      tx.select().from(channelPreference).where(eq(channelPreference.patientId, patientId)),
    );
    expect(after).toMatchObject([
      { channel: 'whatsapp', state: 'opted_in', source: 'patient_email_link' },
    ]);
  });

  it('replaces the link of an earlier request', async () => {
    const patientId = await notes.patient({ phone: '+5491155550199' });
    const notify = notifier();

    const first = await scheduling.inTenant(
      async (tx) =>
        (await notify.requestWhatsAppOptIn?.(tx, { patientId, at: notes.now() })) ?? null,
    );
    const second = await scheduling.inTenant(
      async (tx) =>
        (await notify.requestWhatsAppOptIn?.(tx, { patientId, at: notes.now() })) ?? null,
    );

    expect(second?.token).not.toBe(first?.token);
  });
});
