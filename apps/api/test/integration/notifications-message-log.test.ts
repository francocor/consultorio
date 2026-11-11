import type { AppointmentMessagesResponse } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import {
  recordOptIn,
  recordOptOut,
} from '../../src/modules/notifications/application/preferences.js';
import type { AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createTestAdapterResolver } from '../support/adapters.js';
import { insertAppointmentRow } from '../support/fixture-helpers.js';
import { createRecordingJobClient } from '../support/jobs.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/** The message log of an appointment and the manual resend, as reception uses them. */

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
    slug: 'notif-log',
    app: { adapters: createTestAdapterResolver({ whatsapp }), jobs },
  });
  notes = createNotificationsWorld(scheduling, { jobs, whatsapp });
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
});

async function booked(contact: { email?: string | null; phone?: string | null } = {}) {
  slot += 1;
  const patientId = await notes.patient({
    email: contact.email === undefined ? 'log@example.test' : contact.email,
    phone: contact.phone ?? null,
  });
  const time = `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
  const appointment = await notes.book(patientId, 1 + Math.floor(slot / 8), time);
  return { patientId, appointment };
}

const log = async (appointmentId: string, as = scheduling.reception) => {
  const response = await scheduling.api.get(`/appointments/${appointmentId}/messages`, as);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AppointmentMessagesResponse>();
};

const resend = (appointmentId: string, channel: string, as = scheduling.reception) =>
  scheduling.api.post(`/appointments/${appointmentId}/messages/resend`, as, { channel });

describe('the message log of an appointment', () => {
  it('shows each message with its channel, status, reason and times, and no text or address', async () => {
    const { patientId, appointment } = await booked({
      email: 'privado@example.test',
      phone: '1144445555',
    });
    await scheduling.inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'online_booking',
        actor: patientActor,
      }),
    );
    await notes.queue({
      kind: 'reminder',
      channel: 'email',
      patientId,
      appointmentId: appointment.id,
      professionalId: scheduling.doctor.professionalId,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `log:${appointment.id}:email`,
    });
    await notes.runAllJobs();

    const result = await log(appointment.id);
    const sent = result.messages.find((entry) => entry.channel === 'email');

    expect(sent).toMatchObject({
      kind: 'reminder',
      status: 'sent',
      trigger: 'automatic',
      cancelReason: null,
      failureReason: null,
      attempts: 1,
    });
    expect(sent?.sentAt).toBe('2031-05-06T12:00:00.000Z');
    expect(JSON.stringify(result)).not.toContain('privado');
    expect(JSON.stringify(result)).not.toContain('1144445555');
  });

  it('shows a failure with its reason and a cancellation with its reason', async () => {
    const { patientId, appointment } = await booked({ email: 'falla@example.test' });
    notes.email.script = [{ responseCode: 550 }];
    await notes.queue({
      kind: 'reminder',
      channel: 'email',
      patientId,
      appointmentId: appointment.id,
      professionalId: scheduling.doctor.professionalId,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `log:${appointment.id}:failed:email`,
    });
    await notes.runAllJobs();

    const result = await log(appointment.id);

    expect(
      result.messages.map((entry) => [entry.status, entry.failureReason, entry.cancelReason]),
    ).toEqual(expect.arrayContaining([['failed', 'mailbox_unavailable', null]]));
  });

  it('says there are no automated reminders when reception has an open "reminder not sent" item', async () => {
    const { appointment } = await booked({ email: null, phone: null });
    expect((await log(appointment.id)).noAutomatedReminders).toBe(true);

    const { appointment: ok } = await booked({ email: 'ok@example.test' });
    expect((await log(ok.id)).noAutomatedReminders).toBe(false);
  });

  it('is shown to administration and to reception, and not to a professional', async () => {
    const { appointment } = await booked();

    expect(
      (await scheduling.api.get(`/appointments/${appointment.id}/messages`, scheduling.owner))
        .statusCode,
    ).toBe(200);
    expect(
      (await scheduling.api.get(`/appointments/${appointment.id}/messages`, scheduling.admin))
        .statusCode,
    ).toBe(200);
    expect(
      (await scheduling.api.get(`/appointments/${appointment.id}/messages`, scheduling.doctor))
        .statusCode,
    ).toBe(403);
  });

  it('does not exist for reception when the appointment is at a location it is not assigned to', async () => {
    const { appointment } = await booked();
    await scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE appointment SET location_id = ${scheduling.norte} WHERE id = ${appointment.id}`,
      ),
    );

    const reception = await scheduling.api.get(
      `/appointments/${appointment.id}/messages`,
      scheduling.reception,
    );
    const owner = await scheduling.api.get(
      `/appointments/${appointment.id}/messages`,
      scheduling.owner,
    );

    expect(reception.statusCode).toBe(404);
    expect(owner.statusCode).toBe(200);
  });

  it('answers as not found for an appointment of another organization', async () => {
    const other = await createTestTenant(runtime, {
      slug: `notif-log-x-${crypto.randomUUID().slice(0, 6)}`,
    });
    const foreign = await asTenant(runtime, other.id, (tx) => insertAppointmentRow(tx, other.id));

    const response = await scheduling.api.get(
      `/appointments/${foreign}/messages`,
      scheduling.admin,
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('a manual resend', () => {
  it('queues a reminder on the channel, sends it, counts it and audits it', async () => {
    const { patientId, appointment } = await booked({ email: 'reenvio@example.test' });
    notes.jobs.jobs.length = 0;

    const response = await resend(appointment.id, 'email');

    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<AppointmentMessagesResponse>();
    expect(result.resendsLeft).toBe(2);
    expect(result.messages.filter((entry) => entry.trigger === 'manual')).toHaveLength(1);
    await notes.runAllJobs();
    expect(notes.email.sent.map((mail) => mail.to)).toContain('reenvio@example.test');
    const after = await log(appointment.id);
    expect(after.messages.find((entry) => entry.trigger === 'manual')?.status).toBe('sent');
    const audits = await scheduling.inTenant((tx) =>
      tx
        .select({ metadata: auditEvent.metadata, actor: auditEvent.actorUserId })
        .from(auditEvent)
        .where(
          and(eq(auditEvent.patientId, patientId), eq(auditEvent.action, 'notification.resend')),
        ),
    );
    expect(audits).toEqual([
      { metadata: { channel: 'email', resend: 1 }, actor: scheduling.reception.user.id },
    ]);
  });

  it('refuses a channel the patient opted out of, and says so', async () => {
    const { patientId, appointment } = await booked({ email: 'baja@example.test' });
    await scheduling.inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor: patientActor }),
    );

    const response = await resend(appointment.id, 'email');

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('channel_opted_out');
  });

  it('refuses WhatsApp for a patient who never accepted it', async () => {
    const { appointment } = await booked({ phone: '1144445555' });

    const response = await resend(appointment.id, 'whatsapp');

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('resend_unavailable');
  });

  it('refuses the fourth resend of the same appointment', async () => {
    const { appointment } = await booked({ email: 'cuatro@example.test' });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await resend(appointment.id, 'email')).statusCode, String(attempt)).toBe(200);
    }
    const fourth = await resend(appointment.id, 'email');

    expect(fourth.statusCode).toBe(409);
    expect(fourth.json<{ code: string }>().code).toBe('resend_limit_reached');
    expect((await log(appointment.id)).resendsLeft).toBe(0);
  });

  it('refuses an appointment that was cancelled', async () => {
    const { appointment } = await booked({ email: 'cancelado@example.test' });
    const cancelled = await scheduling.act(appointment, 'cancel', scheduling.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const response = await resend(appointment.id, 'email');

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('resend_unavailable');
  });

  it('needs a signed-in user', async () => {
    const { appointment } = await booked({ email: 'rol@example.test' });

    const response = await scheduling.api.post(
      `/appointments/${appointment.id}/messages/resend`,
      null,
      { channel: 'email' },
    );

    expect(response.statusCode).toBe(401);
  });
});
