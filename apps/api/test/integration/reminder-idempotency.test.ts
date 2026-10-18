import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  callProvider,
  prepareDelivery,
} from '../../src/modules/notifications/application/delivery.js';
import { createReminderSendJob } from '../../src/modules/notifications/application/jobs.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * A reminder reaches the patient once, even when the worker dies after the provider took the
 * message and before the status was written (spec "Automatic reminders": retry does not duplicate).
 */

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let slot = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'reminder-idempotency' });
  notes = createNotificationsWorld(scheduling);
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(() => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.email.reset();
  notes.jobs.jobs.length = 0;
});

async function queuedReminder(email: string) {
  slot += 1;
  const patientId = await notes.patient({ email });
  const appointment = await notes.book(
    patientId,
    1,
    `${String(9 + Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`,
  );
  const id = await notes.queue({
    kind: 'reminder',
    patientId,
    appointmentId: appointment.id,
    plannedStartsAt: new Date(appointment.startsAt),
    appointmentVersion: appointment.version,
    dedupeKey: `idempotency:${appointment.id}:email`,
  });
  return { id, appointment, patientId };
}

describe('reminder.send survives a worker that dies', () => {
  it('does not send an email again when the worker died after the provider accepted it', async () => {
    const { id } = await queuedReminder('muere@example.test');

    // The first worker: claims the message and hands it to the provider, then dies.
    const prepared = await prepareDelivery(notes.deps, scheduling.tenant.id, id);
    expect(prepared.kind).toBe('send');
    if (prepared.kind !== 'send') return;
    expect(await callProvider(prepared.send)).toEqual({
      status: 'accepted',
      providerMessageId: null,
    });
    expect(notes.email.sent).toHaveLength(1);
    expect(await notes.message(id)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await notes.attemptsOf(id)).toEqual([
      { attemptNo: 1, outcome: 'started', reason: null },
    ]);

    // The queue delivers the job again to another worker.
    await notes.runAllJobs();

    expect(notes.email.sent).toHaveLength(1);
    expect(notes.email.calls).toBe(1);
    expect(await notes.message(id)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await notes.attemptsOf(id)).toEqual([
      { attemptNo: 1, outcome: 'error', reason: 'unconfirmed' },
    ]);
  });

  it('does not send an email when the worker died before the provider was called either: at most once', async () => {
    const { id } = await queuedReminder('antes@example.test');
    // Died right after claiming: the attempt is started and nothing was handed over.
    const prepared = await prepareDelivery(notes.deps, scheduling.tenant.id, id);
    expect(prepared.kind).toBe('send');

    await notes.runAllJobs();

    // The reminder is late-marked as sent without proof: a duplicate is worse than a missed one,
    // and reception sees the attempt as unconfirmed.
    expect(notes.email.calls).toBe(0);
    expect(await notes.attemptsOf(id)).toEqual([
      { attemptNo: 1, outcome: 'error', reason: 'unconfirmed' },
    ]);
  });

  it('sends once when two workers get the same message at the same time', async () => {
    const { id } = await queuedReminder('carrera@example.test');
    const definition = createReminderSendJob(notes.deps);
    const run = (jobId: string) =>
      runJob(runtime.db, definition, {
        id: jobId,
        name: 'reminder.send',
        data: { tenantId: scheduling.tenant.id, messageId: id },
        enqueuedAt: notes.now(),
        retryCount: 0,
      });

    await Promise.all([run(crypto.randomUUID()), run(crypto.randomUUID())]);

    expect(notes.email.calls).toBe(1);
    expect(notes.email.sent).toHaveLength(1);
    expect((await notes.message(id)).status).toBe('sent');
  });

  it('keeps one message per reminder when the planner queues it twice', async () => {
    const { id, appointment, patientId } = await queuedReminder('doble@example.test');
    const again = await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `idempotency:${appointment.id}:email`,
    });

    expect(again).toBe(id);
    expect(await notes.messagesOf(appointment.id)).toHaveLength(1);
  });
});
