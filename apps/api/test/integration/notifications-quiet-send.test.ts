import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { worklistItem } from '../../src/db/schema/worklist.js';
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
 * Judgment day finding C8: quiet hours were applied when a reminder was PLANNED, but a retry, a
 * fallback or a job that ran late was sent whenever it ran. They are checked again when the
 * message is about to go: it waits for the end of quiet hours (when that comes before the
 * appointment) and is never dropped for it, except when it could no longer arrive in time.
 */

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let week = 100;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'notif-quiet-send' });
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
  await notes.setTenant({ status: 'active' });
});

// Buenos Aires is UTC-3: 23:00 there is 02:00Z, and 08:00 is 11:00Z.
const AT_23H = new Date('2031-05-07T02:00:00.000Z');
const AT_08H = new Date('2031-05-07T11:00:00.000Z');

async function queued(
  options: { time?: string; kind?: 'reminder' | 'confirmation'; trigger?: 'manual' } = {},
) {
  week += 1;
  const patientId = await notes.patient({ email: `noche${String(week)}@example.test` });
  const appointment = await notes.book(patientId, week, options.time ?? '10:00');
  const id = await notes.queue({
    kind: options.kind ?? 'reminder',
    channel: 'email',
    patientId,
    appointmentId: appointment.id,
    plannedStartsAt: new Date(appointment.startsAt),
    appointmentVersion: appointment.version,
    dedupeKey: `quiet:${appointment.id}:email`,
    ...(options.trigger ? { trigger: options.trigger } : {}),
  });
  return { id, appointment, patientId };
}

describe('a message that runs inside quiet hours', () => {
  it('is not sent: it waits for the end of quiet hours and then goes out', async () => {
    const { id } = await queued();
    notes.jobs.jobs.length = 0;
    notes.setNow(AT_23H);

    // The job of the message runs late, at 23:00 (a retry, a backlog after an outage).
    notes.jobs.jobs.push({
      id: crypto.randomUUID(),
      name: 'reminder.send',
      payload: { tenantId: scheduling.tenant.id, messageId: id },
      options: {},
      done: false,
    });
    await notes.runJobs();

    expect(notes.email.sent).toHaveLength(0);
    const waiting = await notes.message(id);
    expect(waiting).toMatchObject({ status: 'queued', cancelReason: null });
    expect(waiting.sendAt).toEqual(AT_08H);
    expect(notes.jobs.pending('reminder.send').map((job) => job.options.startAfter)).toEqual([
      AT_08H,
    ]);

    notes.setNow(AT_08H);
    await notes.runJobs();

    expect(notes.email.sent).toHaveLength(1);
    expect(await notes.message(id)).toMatchObject({ status: 'sent' });
  });

  it('is not dropped when it could not wait for the morning, but reception is told', async () => {
    // Quiet hours until 10:00, and an appointment at 09:00: the end of quiet hours comes after it.
    const patched = await scheduling.api.patch('/settings', scheduling.owner, {
      quietHours: { start: '21:00', end: '10:00' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    try {
      const { id, appointment } = await queued({ time: '09:00' });
      notes.jobs.jobs.length = 0;
      notes.setNow(new Date(new Date(appointment.startsAt).getTime() - 2 * 60 * 60_000));
      notes.jobs.jobs.push({
        id: crypto.randomUUID(),
        name: 'reminder.send',
        payload: { tenantId: scheduling.tenant.id, messageId: id },
        options: {},
        done: false,
      });

      await notes.runJobs();

      expect(notes.email.sent).toHaveLength(0);
      expect(await notes.message(id)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'no_channel',
      });
      const items = await scheduling.inTenant((tx) =>
        tx
          .select({ kind: worklistItem.kind, status: worklistItem.status })
          .from(worklistItem)
          .where(eq(worklistItem.subjectId, appointment.id)),
      );
      expect(items).toContainEqual({ kind: 'reminder_not_sent', status: 'open' });
    } finally {
      await scheduling.api.patch('/settings', scheduling.owner, {
        quietHours: { start: '21:00', end: '08:00' },
      });
    }
  });

  it('does not wait when the message answers an action or a person asked for it', async () => {
    const confirmation = await queued({ kind: 'confirmation' });
    const manual = await queued({ trigger: 'manual' });
    notes.jobs.jobs.length = 0;
    notes.setNow(AT_23H);
    for (const { id } of [confirmation, manual]) {
      notes.jobs.jobs.push({
        id: crypto.randomUUID(),
        name: 'reminder.send',
        payload: { tenantId: scheduling.tenant.id, messageId: id },
        options: {},
        done: false,
      });
    }

    await notes.runJobs();

    expect(notes.email.sent).toHaveLength(2);
    expect(await notes.message(confirmation.id)).toMatchObject({ status: 'sent' });
    expect(await notes.message(manual.id)).toMatchObject({ status: 'sent' });
  });

  it('waits at the retry too: a transient failure by day, retried at night', async () => {
    const { id } = await queued();
    notes.email.script = [{ responseCode: 421 }];
    await notes.runJobs();
    expect(await notes.message(id)).toMatchObject({ status: 'queued', attempts: 1 });
    const retries = notes.jobs.pending('reminder.send');
    expect(retries).toHaveLength(1);
    notes.setNow(AT_23H);

    await notes.runJobs();

    expect(notes.email.sent).toHaveLength(0);
    expect((await notes.message(id)).sendAt).toEqual(AT_08H);
  });
});
