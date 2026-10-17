import type { AppointmentDto } from '@consultorio/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createReminderPlanner } from '../../src/modules/notifications/application/plan-reminders.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type {
  AppointmentEvent,
  AppointmentFacts,
} from '../../src/platform/events/appointment-events.js';
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
 * The planner turns appointment events into queued reminders. Most of this file drives the planner
 * with events built from real appointments and a clock of its own; the last part books and moves
 * appointments through the real application to prove the wiring needs no call from scheduling.
 */

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let week = 100;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'reminder-plan' });
  notes = createNotificationsWorld(scheduling);
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(async () => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.jobs.jobs.length = 0;
  await setLeadHours([24]);
});

const planner = () =>
  createReminderPlanner({
    jobs: notes.jobs,
    clock: () => notes.now(),
    worklist: notes.deps.worklist,
    whatsappAvailable: () => true,
  });

async function setLeadHours(hours: number[]) {
  const response = await scheduling.api.patch('/settings', scheduling.owner, {
    notifications: { reminderLeadHours: hours },
  });
  expect(response.statusCode, response.body).toBe(200);
}

function factsOf(dto: AppointmentDto, patch: Partial<AppointmentFacts> = {}): AppointmentFacts {
  return {
    appointmentId: dto.id,
    patientId: dto.patientId,
    professionalId: dto.professionalId,
    locationId: dto.locationId,
    appointmentTypeId: dto.appointmentTypeId,
    startsAt: new Date(dto.startsAt),
    endsAt: new Date(dto.endsAt),
    status: dto.status,
    source: dto.source,
    version: dto.version,
    ...patch,
  };
}

const handle = (event: AppointmentEvent) =>
  scheduling.inTenant((tx) => planner().handle(tx, event));

const created = (appointment: AppointmentFacts): AppointmentEvent => ({
  kind: 'created',
  tenantId: scheduling.tenant.id,
  appointment,
});

/** A booked appointment for a patient with an email, on a Monday of its own. */
async function booked(contact: Parameters<NotificationsWorld['patient']>[0] = {}) {
  week += 1;
  const patientId = await notes.patient(contact);
  const dto = await scheduling.book(week, '10:00', { patientId });
  return dto;
}

const plannedFor = async (appointmentId: string) =>
  (await notes.messagesOf(appointmentId)).map((row) => ({
    kind: row.kind,
    channel: row.channel,
    status: row.status,
    cancelReason: row.cancelReason,
    sendAt: row.sendAt.toISOString(),
  }));

describe('the reminder planner', () => {
  it('queues one email reminder 24 hours before the start, with its job, by default', async () => {
    const dto = await booked();

    await handle(created(factsOf(dto)));

    const start = new Date(dto.startsAt).getTime();
    expect(await plannedFor(dto.id)).toEqual([
      {
        kind: 'reminder',
        channel: 'email',
        status: 'queued',
        cancelReason: null,
        sendAt: new Date(start - 24 * 3_600_000).toISOString(),
      },
    ]);
    const jobs = notes.jobs.pending('reminder.send');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.options.startAfter).toEqual(new Date(start - 24 * 3_600_000));
  });

  it('queues up to three reminders at the lead times of the organization', async () => {
    await setLeadHours([72, 24, 2]);
    const dto = await booked();

    await handle(created(factsOf(dto)));

    const rows = await notes.messagesOf(dto.id);
    const start = new Date(dto.startsAt).getTime();
    expect(rows.map((row) => row.sendAt.getTime()).sort()).toEqual(
      [72, 24, 2].map((hours) => start - hours * 3_600_000).sort(),
    );
    expect(rows.every((row) => row.plannedStartsAt?.getTime() === start)).toBe(true);
    expect(notes.jobs.pending('reminder.send')).toHaveLength(3);
  });

  it('queues the same reminder once, however many times the event is delivered', async () => {
    const dto = await booked();

    await handle(created(factsOf(dto)));
    await handle(created(factsOf(dto)));

    expect(await notes.messagesOf(dto.id)).toHaveLength(1);
    expect(notes.jobs.pending('reminder.send')).toHaveLength(1);
  });

  it('plans nothing at all when every lead time is off', async () => {
    await setLeadHours([]);
    const dto = await booked();

    await handle(created(factsOf(dto)));

    expect(await notes.messagesOf(dto.id)).toEqual([]);
    expect(notes.jobs.pending('reminder.send')).toHaveLength(0);
    expect(await notes.worklistKinds(dto.id)).toEqual([]);
  });

  it('replaces the reminders when the appointment moves: the old ones are cancelled', async () => {
    const dto = await booked();
    await handle(created(factsOf(dto)));
    const movedStart = new Date(new Date(dto.startsAt).getTime() + 2 * 86_400_000);

    await handle({
      kind: 'rescheduled',
      tenantId: scheduling.tenant.id,
      appointment: factsOf(dto, { startsAt: movedStart, version: dto.version + 1 }),
      previous: {
        professionalId: dto.professionalId,
        locationId: dto.locationId,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
      },
    });

    const rows = await notes.messagesOf(dto.id);
    expect(rows.map((row) => [row.status, row.cancelReason, row.sendAt.getTime()])).toEqual([
      ['cancelled', 'appointment_changed', new Date(dto.startsAt).getTime() - 24 * 3_600_000],
      ['queued', null, movedStart.getTime() - 24 * 3_600_000],
    ]);
    expect(rows[1]?.plannedStartsAt?.getTime()).toBe(movedStart.getTime());
  });

  it('sends nothing for an appointment that was cancelled before the reminder time', async () => {
    const dto = await booked({ email: 'cancela@example.test' });
    await handle(created(factsOf(dto)));

    await handle({
      kind: 'cancelled',
      tenantId: scheduling.tenant.id,
      appointment: factsOf(dto, { status: 'cancelled', version: dto.version + 1 }),
      fromStatus: 'scheduled',
      cancelledBy: 'patient',
    });
    notes.setNow(new Date(new Date(dto.startsAt).getTime() - 24 * 3_600_000 + 1000));
    await notes.runAllJobs();

    expect(await plannedFor(dto.id)).toMatchObject([
      { status: 'cancelled', cancelReason: 'appointment_cancelled' },
    ]);
    expect(notes.email.sent.filter((mail) => mail.to === 'cancela@example.test')).toEqual([]);
  });

  it('keeps the reminders when the patient confirms, and drops them once the visit happened', async () => {
    const dto = await booked();
    await handle(created(factsOf(dto)));

    await handle({
      kind: 'status_changed',
      tenantId: scheduling.tenant.id,
      appointment: factsOf(dto, { status: 'confirmed', version: dto.version + 1 }),
      fromStatus: 'scheduled',
    });
    expect(await plannedFor(dto.id)).toMatchObject([{ status: 'queued' }]);

    await handle({
      kind: 'status_changed',
      tenantId: scheduling.tenant.id,
      appointment: factsOf(dto, { status: 'attended', version: dto.version + 2 }),
      fromStatus: 'in_progress',
    });
    expect(await plannedFor(dto.id)).toMatchObject([
      { status: 'cancelled', cancelReason: 'appointment_over' },
    ]);
  });

  it('plans when a pending booking is approved, and not before', async () => {
    const dto = await booked();
    await handle(created(factsOf(dto, { status: 'pending_approval' })));
    expect(await notes.messagesOf(dto.id)).toEqual([]);

    await handle({
      kind: 'status_changed',
      tenantId: scheduling.tenant.id,
      appointment: factsOf(dto, { status: 'scheduled', version: dto.version + 1 }),
      fromStatus: 'pending_approval',
    });

    expect(await plannedFor(dto.id)).toMatchObject([{ kind: 'reminder', status: 'queued' }]);
  });

  it('sends only the confirmation, at once, for a booking made inside the lead window', async () => {
    const dto = await booked({ email: 'tarde@example.test' });
    notes.setNow(new Date(new Date(dto.startsAt).getTime() - 3 * 3_600_000));

    await handle(created(factsOf(dto)));

    expect(await plannedFor(dto.id)).toEqual([
      {
        kind: 'confirmation',
        channel: 'email',
        status: 'queued',
        cancelReason: null,
        sendAt: notes.now().toISOString(),
      },
    ]);
    await notes.runAllJobs();
    expect(notes.email.sent.map((mail) => [mail.to, mail.subject])).toEqual([
      ['tarde@example.test', expect.stringMatching(/^Su turno en .* está confirmado$/) as string],
    ]);
  });

  it('keeps the reminder that is still ahead and confirms at once for the one that is overdue', async () => {
    await setLeadHours([24, 2]);
    const dto = await booked();
    notes.setNow(new Date(new Date(dto.startsAt).getTime() - 5 * 3_600_000));

    await handle(created(factsOf(dto)));

    const rows = await notes.messagesOf(dto.id);
    expect(rows.map((row) => row.kind).sort()).toEqual(['confirmation', 'reminder']);
    const reminder = rows.find((row) => row.kind === 'reminder');
    expect(reminder?.sendAt.getTime()).toBe(new Date(dto.startsAt).getTime() - 2 * 3_600_000);
  });

  it('queues nothing and tells reception when the patient has no way to be reached', async () => {
    const dto = await booked({ email: null, phone: null });

    await handle(created(factsOf(dto)));

    expect(await notes.messagesOf(dto.id)).toEqual([]);
    expect(await notes.worklistKinds(dto.id)).toEqual(['reminder_not_sent']);
  });

  it('defers a reminder that falls due in quiet hours to their end (appointment at 10:00, 11 hours before)', async () => {
    await setLeadHours([11]);
    const dto = await booked();

    await handle(created(factsOf(dto)));

    // 10:00 - 11 h = 23:00 the day before: quiet. The end of quiet hours is 08:00 on the day.
    const start = new Date(dto.startsAt);
    expect((await notes.messagesOf(dto.id)).map((row) => row.sendAt.toISOString())).toEqual([
      new Date(start.getTime() - 2 * 3_600_000).toISOString(),
    ]);
  });

  it('skips a reminder that cannot be deferred before the start and opens "reminder not sent"', async () => {
    await setLeadHours([1]);
    const dto = await booked();
    // The appointment starts at 07:30 local (10:30 UTC): the reminder falls due at 06:30.
    const early = new Date(new Date(dto.startsAt).getTime() - 2.5 * 3_600_000);

    await handle(created(factsOf(dto, { startsAt: early })));

    expect(await notes.messagesOf(dto.id)).toEqual([]);
    expect(await notes.worklistKinds(dto.id)).toEqual(['reminder_not_sent']);
  });
});

describe('the planner wired to the application, with no call from scheduling', () => {
  let app: SchedulingHttpWorld;
  let wired: NotificationsWorld;
  let weekApp = 200;

  beforeAll(async () => {
    const jobs = createRecordingJobClient();
    app = await createSchedulingHttpWorld(runtime, {
      slug: 'reminder-plan-app',
      app: { jobs },
    });
    wired = createNotificationsWorld(app, { jobs });
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps the queue right while an appointment is booked, moved and cancelled', async () => {
    weekApp += 1;
    const patientId = await wired.patient({ email: 'cola@example.test' });
    const dto = await app.book(weekApp, '10:00', { patientId });
    const start = new Date(dto.startsAt).getTime();

    expect(await wired.messagesOf(dto.id)).toMatchObject([
      { status: 'queued', sendAt: new Date(start - 24 * 3_600_000) },
    ]);

    const moved = await app.act(dto, 'reschedule', app.reception, {
      local: { date: app.monday(weekApp + 1), time: '10:30' },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const afterMove = await wired.messagesOf(dto.id);
    expect(afterMove.map((row) => [row.status, row.cancelReason])).toEqual([
      ['cancelled', 'appointment_changed'],
      ['queued', null],
    ]);

    const current = await app.act({ id: dto.id }, 'cancel', app.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });
    expect(current.statusCode, current.body).toBe(200);

    const afterCancel = await wired.messagesOf(dto.id);
    expect(afterCancel.map((row) => [row.status, row.cancelReason])).toEqual([
      ['cancelled', 'appointment_changed'],
      ['cancelled', 'appointment_cancelled'],
    ]);
  });
});
