import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { message, messageAttempt } from '../../src/db/schema/notifications.js';
import { prepareDelivery } from '../../src/modules/notifications/application/delivery.js';
import { createReminderSendJob } from '../../src/modules/notifications/application/jobs.js';
import { queueMessage } from '../../src/modules/notifications/application/queue.js';
import { hashAddress } from '../../src/modules/notifications/domain/address.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
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

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let week = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'notif-send' });
  notes = createNotificationsWorld(scheduling);
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(async () => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.email.reset();
  notes.jobs.jobs.length = 0;
  notes.demoEmail.clear();
  await notes.setTenant({ status: 'active' });
});

/** A booked appointment for a new patient with these contacts, on a Monday of its own. */
async function bookedFor(contact: Parameters<NotificationsWorld['patient']>[0] = {}) {
  week += 1;
  const patientId = await notes.patient(contact);
  const appointment = await notes.book(patientId, week);
  return { patientId, appointment };
}

async function queueReminder(
  patientId: string,
  appointment: { id: string; startsAt: string; version: number },
  extra: Partial<Parameters<NotificationsWorld['queue']>[0]> = {},
) {
  return notes.queue({
    kind: 'reminder',
    channel: 'email',
    patientId,
    appointmentId: appointment.id,
    plannedStartsAt: new Date(appointment.startsAt),
    appointmentVersion: appointment.version,
    dedupeKey: `reminder:${appointment.id}:24:email`,
    ...extra,
  });
}

describe('reminder.send: delivery by email', () => {
  it('sends the reminder to the patient, in es-AR, and records it as sent with its attempt', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'ana@example.test' });
    const id = await queueReminder(patientId, appointment);

    await notes.runAllJobs();

    expect(notes.email.sent).toHaveLength(1);
    const sent = notes.email.sent[0];
    expect(sent).toMatchObject({
      to: 'ana@example.test',
      tenant: { id: scheduling.tenant.id, isDemo: false },
    });
    expect(sent?.subject).toMatch(/^Recordatorio de su turno en /);
    expect(sent?.text).toContain('Hola Ana:');
    expect(sent?.text).toContain('Hora: 10:00');
    const row = await notes.message(id);
    expect(row).toMatchObject({
      status: 'sent',
      attempts: 1,
      cancelReason: null,
      addressHash: hashAddress('email', 'ana@example.test'),
    });
    expect(row.sentAt).toEqual(notes.now());
    expect(await notes.attemptsOf(id)).toEqual([
      { attemptNo: 1, outcome: 'accepted', reason: null },
    ]);
  });

  it('keeps the address out of the log: only its hash is stored', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'privada@example.test' });
    const id = await queueReminder(patientId, appointment);

    await notes.runAllJobs();

    const row = await notes.message(id);
    expect(JSON.stringify(row)).not.toContain('privada');
  });

  it('sends one message even when the job runs twice for the same message', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'dos@example.test' });
    const id = await queueReminder(patientId, appointment);
    await notes.runAllJobs();
    // A second delivery of the same message (another job, or a replay).
    notes.jobs.jobs.push({
      id: crypto.randomUUID(),
      name: 'reminder.send',
      payload: { tenantId: scheduling.tenant.id, messageId: id },
      options: {},
      done: false,
    });
    await notes.runAllJobs();

    expect(notes.email.calls).toBe(1);
    expect((await notes.message(id)).status).toBe('sent');
  });

  it('retries a temporary failure after a growing wait, and sends only once', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'luego@example.test' });
    const id = await queueReminder(patientId, appointment);
    notes.email.script = [{ responseCode: 421 }];

    await notes.runJobs();

    expect((await notes.message(id)).status).toBe('queued');
    const retry = notes.jobs.pending('reminder.send');
    expect(retry).toHaveLength(1);
    expect(retry[0]?.options.startAfter).toEqual(new Date(notes.now().getTime() + 60_000));

    notes.setNow(new Date(notes.now().getTime() + 61_000));
    await notes.runJobs();

    expect(notes.email.sent).toHaveLength(1);
    expect(await notes.attemptsOf(id)).toEqual([
      { attemptNo: 1, outcome: 'retryable', reason: 'provider_down' },
      { attemptNo: 2, outcome: 'accepted', reason: null },
    ]);
    expect(await notes.message(id)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('gives up after three temporary failures and asks reception to follow up', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'siempre@example.test' });
    const id = await queueReminder(patientId, appointment);
    notes.email.script = [{ responseCode: 421 }, { responseCode: 421 }, { responseCode: 421 }];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await notes.runJobs();
      notes.setNow(new Date(notes.now().getTime() + 16 * 60_000));
    }

    expect(await notes.message(id)).toMatchObject({
      status: 'failed',
      failureReason: 'retries_exhausted',
      attempts: 3,
    });
    expect(notes.jobs.pending('reminder.send')).toHaveLength(0);
    expect(await notes.worklistKinds(appointment.id)).toEqual(['reminder_not_delivered']);
  });

  it('does not retry past the start of the appointment', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'tarde@example.test' });
    const id = await queueReminder(patientId, appointment);
    // 30 seconds before the start: the first retry (one minute later) would land after it.
    notes.setNow(new Date(new Date(appointment.startsAt).getTime() - 30_000));
    notes.email.script = [{ responseCode: 421 }];

    await notes.runJobs();

    expect(await notes.message(id)).toMatchObject({
      status: 'failed',
      failureReason: 'retries_exhausted',
    });
    expect(notes.jobs.pending('reminder.send')).toHaveLength(0);
  });

  it('marks a mailbox the server refuses as unreachable and does not write to it again', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'nadie@example.test' });
    const first = await queueReminder(patientId, appointment);
    notes.email.script = [{ responseCode: 550 }];

    await notes.runAllJobs();

    expect(await notes.message(first)).toMatchObject({
      status: 'failed',
      failureReason: 'mailbox_unavailable',
    });
    expect(await notes.worklistKinds(appointment.id)).toEqual(['reminder_not_delivered']);

    const calls = notes.email.calls;
    const second = await queueReminder(patientId, appointment, {
      dedupeKey: `reminder:${appointment.id}:2:email`,
    });
    await notes.runAllJobs();

    expect(notes.email.calls).toBe(calls);
    expect(await notes.message(second)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'no_channel',
    });
  });

  it('writes to a corrected address again: a new address is not the one that failed', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'mal@example.test' });
    await queueReminder(patientId, appointment);
    notes.email.script = [{ responseCode: 550 }];
    await notes.runAllJobs();

    await scheduling.inTenant((tx) =>
      tx.execute(sql`UPDATE patient SET email = 'bien@example.test' WHERE id = ${patientId}`),
    );
    const again = await queueReminder(patientId, appointment, {
      dedupeKey: `reminder:${appointment.id}:3:email`,
    });
    await notes.runAllJobs();

    expect(await notes.message(again)).toMatchObject({ status: 'sent' });
    expect(notes.email.sent.at(-1)?.to).toBe('bien@example.test');
  });
});

describe('reminder.send: when the message should not go', () => {
  it('cancels for a patient without an email and tells reception the reminder was not sent', async () => {
    const { patientId, appointment } = await bookedFor({ email: null });
    const id = await queueReminder(patientId, appointment);
    const calls = notes.email.calls;

    await notes.runAllJobs();

    expect(notes.email.calls).toBe(calls);
    expect(await notes.message(id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'no_channel',
    });
    expect(await notes.worklistKinds(appointment.id)).toEqual(['reminder_not_sent']);
  });

  it('cancels when the appointment was cancelled after the message was queued', async () => {
    const { patientId, appointment } = await bookedFor();
    const id = await queueReminder(patientId, appointment);
    const calls = notes.email.calls;
    const response = await scheduling.act(appointment, 'cancel', scheduling.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });
    expect(response.statusCode, response.body).toBe(200);

    await notes.runAllJobs();

    expect(notes.email.calls).toBe(calls);
    expect(await notes.message(id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'appointment_cancelled',
    });
  });

  it('cancels when the appointment moved to another time', async () => {
    const { patientId, appointment } = await bookedFor();
    const id = await queueReminder(patientId, appointment);
    const calls = notes.email.calls;
    // Planned for a start that is no longer the appointment's.
    await scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE message SET planned_starts_at = planned_starts_at - interval '1 day' WHERE id = ${id}`,
      ),
    );

    await notes.runAllJobs();

    expect(notes.email.calls).toBe(calls);
    expect(await notes.message(id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'appointment_changed',
    });
  });

  it('sends after the patient confirmed: a change of status is not a move', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'confirmo@example.test' });
    const id = await queueReminder(patientId, appointment);
    const response = await scheduling.act(appointment, 'confirm', scheduling.reception);
    expect(response.statusCode, response.body).toBe(200);

    await notes.runAllJobs();

    expect(await notes.message(id)).toMatchObject({ status: 'sent' });
  });

  it('cancels a message that comes due after the appointment started', async () => {
    const { patientId, appointment } = await bookedFor();
    const id = await queueReminder(patientId, appointment);
    notes.setNow(new Date(new Date(appointment.startsAt).getTime() + 60_000));

    await notes.runAllJobs();

    expect(await notes.message(id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'appointment_over',
    });
  });

  it('never sends for a demo organization: the message is cancelled before it leaves', async () => {
    const demo = await createTestTenant(runtime, { slug: 'notif-send-demo', isDemo: true });
    const queued = await asTenant(runtime, demo.id, async (tx) => {
      const patientId = await insertPatient(tx, demo.id);
      await tx.execute(sql`UPDATE patient SET email = 'demo@example.test' WHERE id = ${patientId}`);
      const appointmentId = await insertAppointmentRow(tx, demo.id, { patient_id: patientId });
      const [row] = await tx
        .execute<{ starts_at: string }>(
          sql`SELECT starts_at FROM appointment WHERE id = ${appointmentId}`,
        )
        .then((result) => result.rows);
      return queueMessage(notes.deps, tx, {
        kind: 'reminder',
        channel: 'email',
        patientId,
        appointmentId,
        professionalId: null,
        plannedStartsAt: row ? new Date(row.starts_at) : null,
        appointmentVersion: 1,
        sendAt: notes.now(),
        dedupeKey: 'demo:reminder:email',
      });
    });
    const calls = notes.email.calls + notes.demoEmail.sent.length;

    expect(await prepareDelivery(notes.deps, demo.id, queued.id)).toEqual({ kind: 'settled' });

    expect(notes.email.calls + notes.demoEmail.sent.length).toBe(calls);
    const [row] = await asTenant(runtime, demo.id, (tx) =>
      tx.select().from(message).where(eq(message.id, queued.id)),
    );
    expect(row).toMatchObject({ status: 'cancelled', cancelReason: 'demo_tenant' });
    const attempts = await asTenant(runtime, demo.id, (tx) =>
      tx.select().from(messageAttempt).where(eq(messageAttempt.messageId, queued.id)),
    );
    expect(attempts).toEqual([]);
  });

  it('does not run for a read-only organization, and cancels the message when the check is reached', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'frozen@example.test' });
    const id = await queueReminder(patientId, appointment);
    await notes.setTenant({ status: 'read_only' });
    const calls = notes.email.calls;

    const [outcome] = await notes.runJobs();

    // The platform gate cancels the job before the handler; the message stays queued for the
    // sweep to close. Nothing was sent either way.
    expect(outcome).toMatchObject({ result: { status: 'cancelled', reason: 'tenant_read_only' } });
    expect(notes.email.calls).toBe(calls);

    // The handler's own check (the sweep, and a read-only flip during the job) cancels with a reason.
    expect(await prepareDelivery(notes.deps, scheduling.tenant.id, id)).toEqual({
      kind: 'settled',
    });
    expect(await notes.message(id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'tenant_read_only',
    });
  });

  it('does not touch a message that is no longer queued', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'hecho@example.test' });
    const id = await queueReminder(patientId, appointment);
    await notes.runAllJobs();
    const calls = notes.email.calls;

    expect(await prepareDelivery(notes.deps, scheduling.tenant.id, id)).toEqual({ kind: 'idle' });
    expect(notes.email.calls).toBe(calls);
  });
});

describe('reminder.send: a job runs through the platform wrapper', () => {
  it('is recorded as done once, so a redelivery of the same job id does nothing', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'wrapper@example.test' });
    const id = await queueReminder(patientId, appointment);
    const job = notes.jobs.jobs.find((entry) => entry.payload['messageId'] === id);
    const definition = createReminderSendJob(notes.deps);
    const input = {
      id: job?.id ?? '',
      name: 'reminder.send',
      data: job?.payload,
      enqueuedAt: new Date(),
      retryCount: 0,
    };

    const first = await runJob(runtime.db, definition, input);
    const second = await runJob(runtime.db, definition, input);

    expect(first).toEqual({ status: 'completed' });
    expect(second).toEqual({ status: 'duplicate' });
    expect((await notes.message(id)).status).toBe('sent');
  });
});
