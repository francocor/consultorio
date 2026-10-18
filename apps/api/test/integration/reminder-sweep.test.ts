import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { message } from '../../src/db/schema/notifications.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import { rehashLegacyAddresses } from '../../src/modules/notifications/application/address-rehash.js';
import { createReminderSweepJob } from '../../src/modules/notifications/application/sweep.js';
import { hashAddress, legacyAddressHash } from '../../src/modules/notifications/domain/address.js';
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

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let booked = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'reminder-sweep' });
  notes = createNotificationsWorld(scheduling);
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(async () => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.jobs.jobs.length = 0;
  // Active first: an earlier test may have left the organization read-only, which refuses the PATCH.
  await notes.setTenant({ status: 'active' });
  const response = await scheduling.api.patch('/settings', scheduling.owner, {
    notifications: { reminderLeadHours: [24] },
  });
  expect(response.statusCode, response.body).toBe(200);
});

/** Runs the sweep of the organization once, the way the worker's hourly tick would. */
async function sweep() {
  const definition = createReminderSweepJob({ ...notes.deps });
  return runJob(runtime.db, definition, {
    id: crypto.randomUUID(),
    name: 'reminder.sweep',
    data: { tenantId: scheduling.tenant.id },
    enqueuedAt: notes.now(),
    retryCount: 0,
  });
}

async function openItems(appointmentId: string) {
  return scheduling.inTenant((tx) =>
    tx
      .select({ kind: worklistItem.kind, status: worklistItem.status })
      .from(worklistItem)
      .where(eq(worklistItem.subjectId, appointmentId)),
  );
}

async function bookedFor(contact: Parameters<NotificationsWorld['patient']>[0]) {
  // The sweep looks six weeks ahead: the first slots of the first weeks, one per call.
  booked += 1;
  const slot = booked % 8;
  const time = `${String(9 + Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
  const patientId = await notes.patient(contact);
  return { patientId, appointment: await notes.book(patientId, 1 + Math.floor(booked / 8), time) };
}

describe('reminder.sweep: appointments nobody can remind', () => {
  it('opens "reminder not sent" once for a patient with no email and no phone', async () => {
    const { appointment } = await bookedFor({ email: null, phone: null });

    expect(await sweep()).toEqual({ status: 'completed' });
    await sweep();

    expect(await openItems(appointment.id)).toEqual([
      { kind: 'reminder_not_sent', status: 'open' },
    ]);
    expect(await notes.messagesOf(appointment.id)).toEqual([]);
  });

  it('closes the need on the next sweep once the contact is fixed, and plans the reminders', async () => {
    const { patientId, appointment } = await bookedFor({ email: null, phone: null });
    await sweep();

    await scheduling.inTenant((tx) =>
      tx.execute(sql`UPDATE patient SET email = 'arreglado@example.test' WHERE id = ${patientId}`),
    );
    await sweep();

    expect(await openItems(appointment.id)).toEqual([
      { kind: 'reminder_not_sent', status: 'resolved' },
    ]);
    const rows = await notes.messagesOf(appointment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'reminder', channel: 'email', status: 'queued' });
  });

  it('does not flag a reachable patient whose reminders are already queued', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'ok@example.test' });
    await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `sweep:${appointment.id}:email`,
      sendAt: new Date(new Date(appointment.startsAt).getTime() - 24 * 3_600_000),
    });

    await sweep();

    expect(await openItems(appointment.id)).toEqual([]);
    expect(await notes.messagesOf(appointment.id)).toHaveLength(1);
  });

  it('does not plan again an appointment that was planned and whose reminders were cancelled', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'baja@example.test' });
    const id = await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `sweep:${appointment.id}:cancelled:email`,
    });
    await scheduling.inTenant((tx) =>
      tx
        .update(message)
        .set({ status: 'cancelled', cancelReason: 'opted_out' })
        .where(eq(message.id, id)),
    );

    await sweep();

    expect(await notes.messagesOf(appointment.id)).toHaveLength(1);
    expect(await openItems(appointment.id)).toEqual([]);
  });

  it('does nothing when the organization switched every reminder off', async () => {
    const response = await scheduling.api.patch('/settings', scheduling.owner, {
      notifications: { reminderLeadHours: [] },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { appointment } = await bookedFor({ email: null, phone: null });

    await sweep();

    expect(await openItems(appointment.id)).toEqual([]);
  });

  it('sends no confirmation for an appointment it plans late: it only queues reminders still ahead', async () => {
    const { appointment } = await bookedFor({ email: null, phone: null });
    await sweep();
    await scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE patient SET email = 'tarde@example.test' WHERE id = (SELECT patient_id FROM appointment WHERE id = ${appointment.id})`,
      ),
    );
    // Inside the lead window now: the 24 hour reminder is overdue.
    notes.setNow(new Date(new Date(appointment.startsAt).getTime() - 3 * 3_600_000));

    await sweep();

    expect(await notes.messagesOf(appointment.id)).toEqual([]);
  });
});

describe('reminder.sweep: messages left behind', () => {
  it('cancels a queued message whose job was cancelled while the organization was read-only', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'viejo@example.test' });
    const id = await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `sweep:${appointment.id}:stale:email`,
      sendAt: new Date(notes.now().getTime() - 3 * 3_600_000),
    });

    await sweep();

    expect(await notes.message(id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'tenant_read_only',
    });
  });

  it('leaves a message that is only a little late: its retry may be on the way', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'reciente@example.test' });
    const id = await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `sweep:${appointment.id}:recent:email`,
      sendAt: new Date(notes.now().getTime() - 20 * 60_000),
    });

    await sweep();

    expect((await notes.message(id)).status).toBe('queued');
  });

  it('is a write job: a read-only organization does not sweep', async () => {
    await notes.setTenant({ status: 'read_only' });

    expect(await sweep()).toEqual({ status: 'cancelled', reason: 'tenant_read_only' });
  });
});

describe('reminder.sweep: addresses hashed before the pepper', () => {
  it('rewrites the unsalted hash of a message to the keyed one when the patient still has that address, and forgets one that no longer matches', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'viejo@example.test' });
    const kept = await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `legacy:${appointment.id}:kept`,
    });
    const gone = await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `legacy:${appointment.id}:gone`,
    });
    await scheduling.inTenant(async (tx) => {
      await tx
        .update(message)
        .set({ addressHash: legacyAddressHash('email', 'viejo@example.test') })
        .where(eq(message.id, kept));
      await tx
        .update(message)
        .set({ addressHash: legacyAddressHash('email', 'otro-correo@example.test') })
        .where(eq(message.id, gone));
    });

    await sweep();

    expect((await notes.message(kept)).addressHash).toBe(
      hashAddress('email', 'viejo@example.test'),
    );
    expect((await notes.message(gone)).addressHash).toBeNull();
  });
});

describe('the address rehash goes newest first (JD-S3 R2-C4)', () => {
  it('rehashes the most recent messages first, so a patient who wrote lately is found before the log is done', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'reciente@example.test' });
    const ids: string[] = [];
    for (const [index, day] of ['01', '02', '03'].entries()) {
      ids.push(
        await notes.queue({
          kind: 'reminder',
          patientId,
          appointmentId: appointment.id,
          plannedStartsAt: new Date(appointment.startsAt),
          appointmentVersion: appointment.version,
          dedupeKey: `rehash-order:${appointment.id}:${String(index)}`,
        }),
      );
      await scheduling.inTenant((tx) =>
        tx.execute(
          sql`UPDATE message SET created_at = ${`2031-04-${day}T00:00:00Z`}::timestamptz,
                                  address_hash = ${legacyAddressHash('email', 'reciente@example.test')}
               WHERE id = ${ids[index] ?? ''}`,
        ),
      );
    }

    // A batch of one: only the newest row can be done.
    await scheduling.inTenant((tx) => rehashLegacyAddresses(tx, { batch: 1 }));

    const hashes = await Promise.all(ids.map(async (id) => (await notes.message(id)).addressHash));
    expect(hashes).toEqual([
      legacyAddressHash('email', 'reciente@example.test'),
      legacyAddressHash('email', 'reciente@example.test'),
      hashAddress('email', 'reciente@example.test'),
    ]);
  });
});

describe('reminder.sweep: more appointments than a page (JD-S3 B9)', () => {
  it('goes through every appointment of the horizon, page after page, not just the nearest ones', async () => {
    // Five patients nobody can remind, each with an appointment: with pages of two, the nearest
    // two used to be all that one run looked at, and the others waited for ever behind them.
    const booked = [];
    for (let index = 0; index < 5; index += 1) {
      booked.push(await bookedFor({ email: null, phone: null }));
    }
    const definition = createReminderSweepJob({ ...notes.deps }, { pageSize: 2 });

    await runJob(runtime.db, definition, {
      id: crypto.randomUUID(),
      name: 'reminder.sweep',
      data: { tenantId: scheduling.tenant.id },
      enqueuedAt: notes.now(),
      retryCount: 0,
    });

    for (const { appointment } of booked) {
      expect(await openItems(appointment.id), appointment.id).toEqual([
        { kind: 'reminder_not_sent', status: 'open' },
      ]);
    }
  });

  it('leaves alone an appointment whose reminders are planned and live', async () => {
    const { patientId, appointment } = await bookedFor({ email: 'ok@example.test' });
    await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `paged:${appointment.id}:email`,
    });

    await sweep();

    expect(await openItems(appointment.id)).toEqual([]);
    expect(await notes.messagesOf(appointment.id)).toHaveLength(1);
  });
});
