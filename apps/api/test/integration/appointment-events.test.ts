import { randomUUID } from 'node:crypto';

import type { AppointmentDto, BlockDto } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { appointment, slotHold } from '../../src/db/schema/scheduling.js';
import { createSchedulingPorts } from '../../src/modules/scheduling/application/drizzle-ports.js';
import { createHold } from '../../src/modules/scheduling/application/holds.js';
import { HOLD_EXPIRE_JOB, holdExpireJob } from '../../src/modules/scheduling/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createAppointmentEvents,
  type AppointmentEvent,
} from '../../src/platform/events/appointment-events.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;
const events = createAppointmentEvents();
let heard: AppointmentEvent[] = [];

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, {
    slug: 'sched-events',
    app: { appointmentEvents: events },
  });
  events.subscribe((_tx, event) => {
    heard.push(event);
    return Promise.resolve();
  });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

beforeEach(() => {
  heard = [];
  world.setNow(new Date('2031-05-05T12:00:00.000Z'));
});

const kinds = () => heard.map((event) => event.kind);

describe('what scheduling publishes on the appointment event bus', () => {
  it('publishes one created event for a booking, after the write, with the tenant', async () => {
    const created = await world.book(1, '10:00');

    expect(kinds()).toEqual(['created']);
    expect(heard[0]).toMatchObject({
      kind: 'created',
      tenantId: world.tenant.id,
      appointment: {
        appointmentId: created.id,
        patientId: created.patientId,
        professionalId: world.doctor.professionalId,
        locationId: world.centro,
        appointmentTypeId: world.consulta,
        status: 'scheduled',
        source: 'staff',
        version: 1,
      },
    });
  });

  it('publishes one created event for each session of a series', async () => {
    const first = await world.bookingBody(2, '11:00');

    const response = await world.api.post('/appointments/series', world.reception, {
      ...first,
      recurrence: { frequency: 'weekly', count: 3 },
      mode: 'commit',
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(kinds()).toEqual(['created', 'created', 'created']);
  });

  it('publishes status_changed for a confirmation, with the version it ended on', async () => {
    const created = await world.book(3, '10:00');
    heard = [];

    const response = await world.act(created, 'confirm', world.reception);

    expect(response.statusCode).toBe(200);
    expect(kinds()).toEqual(['status_changed']);
    expect(heard[0]).toMatchObject({
      fromStatus: 'scheduled',
      appointment: { appointmentId: created.id, status: 'confirmed', version: 2 },
    });
  });

  it('publishes cancelled and slot_freed when an appointment is cancelled', async () => {
    const created = await world.book(4, '10:00');
    heard = [];

    const response = await world.act(created, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(kinds()).toEqual(['cancelled', 'slot_freed']);
    const freed = heard[1];
    expect(freed).toMatchObject({
      kind: 'slot_freed',
      cause: 'cancelled',
      slot: { professionalId: world.doctor.professionalId, locationId: world.centro },
      appointment: { appointmentId: created.id },
    });
    expect(freed?.kind === 'slot_freed' && freed.slot.startsAt.toISOString()).toBe(
      created.startsAt,
    );
  });

  it('publishes rescheduled and slot_freed for the range an appointment left', async () => {
    const created = await world.book(5, '10:00');
    heard = [];

    const response = await world.act(created, 'reschedule', world.reception, {
      local: { date: world.monday(5), time: '11:00' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(kinds()).toEqual(['rescheduled', 'slot_freed']);
    expect(heard[1]).toMatchObject({ kind: 'slot_freed', cause: 'rescheduled' });
    const freed = heard[1];
    expect(freed?.kind === 'slot_freed' && freed.slot.startsAt.toISOString()).toBe(
      created.startsAt,
    );
  });

  it('publishes reassigned and slot_freed when the professional changes', async () => {
    const created = await world.book(6, '10:00');
    heard = [];

    const response = await world.act(created, 'reschedule', world.reception, {
      professionalId: world.colleague.professionalId,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(kinds()).toEqual(['reassigned', 'slot_freed']);
    expect(heard[1]).toMatchObject({
      cause: 'reassigned',
      slot: { professionalId: world.doctor.professionalId },
    });
  });

  it('publishes slot_freed when a block is removed, for each occurrence', async () => {
    const date = world.monday(7);
    const block = await world.api.post('/schedule-blocks', world.owner, {
      professionalId: world.doctor.professionalId,
      startsAt: `${date}T13:00:00.000Z`,
      endsAt: `${date}T14:00:00.000Z`,
      reason: 'Course',
    });
    const [created] = block.json<{ blocks: BlockDto[] }>().blocks;
    heard = [];

    const removed = await world.api.delete(`/schedule-blocks/${created?.id ?? ''}`, world.owner);

    expect(removed.statusCode, removed.body).toBe(204);
    expect(kinds()).toEqual(['slot_freed']);
    expect(heard[0]).toMatchObject({
      cause: 'block_removed',
      tenantId: world.tenant.id,
      slot: { professionalId: world.doctor.professionalId, locationId: null },
      appointment: null,
    });
  });

  it('never publishes slot_freed when a hold runs out: the lazy expiry and the job stay silent', async () => {
    const date = world.monday(8);
    const startsAt = new Date('2031-05-05T12:00:00.000Z');
    const hold = await world.inTenant((tx) =>
      createHold(createSchedulingPorts(tx, { keys: world.keys, events }), {
        request: {
          professionalId: world.doctor.professionalId,
          locationId: world.centro,
          appointmentTypeId: world.consulta,
          local: { date, time: '10:00' },
        },
        actor: { userId: world.reception.user.id, permissions: new Set(), professionalId: null },
        now: startsAt,
        origin: 'public',
        sourceKey: 'anonymous-session-events',
      }),
    );
    await world.inTenant((tx) =>
      tx
        .update(slotHold)
        .set({ expiresAt: new Date('2020-01-01T00:00:00.000Z') })
        .where(eq(slotHold.id, hold.id)),
    );

    const ran = await runJob(runtime.db, holdExpireJob, {
      id: randomUUID(),
      name: HOLD_EXPIRE_JOB,
      data: { tenantId: world.tenant.id },
      enqueuedAt: new Date(),
      retryCount: 0,
    });
    const [row] = await world.inTenant((tx) =>
      tx.select({ status: slotHold.status }).from(slotHold).where(eq(slotHold.id, hold.id)),
    );

    expect(ran.status).toBe('completed');
    expect(row?.status).toBe('expired');
    expect(heard).toEqual([]);
  });

  it('rolls the business write back when a subscriber fails', async () => {
    const stop = events.subscribe((_tx, event) =>
      event.kind === 'created'
        ? Promise.reject(new Error('the reminder planner is down'))
        : Promise.resolve(),
    );
    const body = await world.bookingBody(9, '10:00');

    let response;
    try {
      response = await world.api.post('/appointments', world.reception, body);
    } finally {
      stop();
    }
    const stored = await world.inTenant((tx) =>
      tx
        .select({ id: appointment.id })
        .from(appointment)
        .where(eq(appointment.patientId, String(body['patientId']))),
    );

    expect(response.statusCode).toBe(500);
    expect(stored).toEqual([]);

    // Without the failing subscriber the very same booking succeeds: nothing was left behind.
    const again = await world.api.post('/appointments', world.reception, body);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json<AppointmentDto>().status).toBe('scheduled');
  });
});
