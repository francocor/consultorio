import type {
  AppointmentDto,
  AppointmentHistoryResponse,
  AuditAction,
  Problem,
  SlotConflictExtension,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { occupancyOf } from '../support/scheduling.js';
import { asTenant } from '../support/tenants.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, { slug: 'sched-lifecycle' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const url = (created: AppointmentDto, action: string) => `/appointments/${created.id}/${action}`;

async function audits(action: AuditAction) {
  return asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

async function stored(created: AppointmentDto) {
  const [row] = await asTenant(runtime, world.tenant.id, (tx) =>
    tx.select().from(appointment).where(eq(appointment.id, created.id)),
  );
  return row;
}

/** Moves the clock of scheduling to just after the appointment starts. */
const afterStart = (created: AppointmentDto) => {
  world.setNow(new Date(Date.parse(created.startsAt) + 5 * 60_000));
};
const backToStart = () => {
  world.setNow(new Date('2031-05-05T12:00:00.000Z'));
};

describe('the attendance lifecycle', () => {
  it('walks confirm, check in, start and attend, with the history and the audit trail', async () => {
    backToStart();
    const created = await world.book(1, '10:00');
    const api = world.api;

    const confirmed = await world.act(created, 'confirm', world.reception);
    const checkedIn = await world.act(created, 'check-in', world.reception);
    const started = await world.act(created, 'start', world.doctor);
    const attended = await world.act(created, 'attend', world.doctor);

    expect(confirmed.json<AppointmentDto>().status).toBe('confirmed');
    expect(checkedIn.json<AppointmentDto>().status).toBe('checked_in');
    expect(started.json<AppointmentDto>().status).toBe('in_progress');
    expect(attended.json<AppointmentDto>()).toMatchObject({ status: 'attended', version: 5 });

    const history = (
      await api.get(url(created, 'history'), world.reception)
    ).json<AppointmentHistoryResponse>();
    expect(history.events.map((event) => [event.kind, event.fromStatus, event.toStatus])).toEqual([
      ['created', null, 'scheduled'],
      ['status_changed', 'scheduled', 'confirmed'],
      ['status_changed', 'confirmed', 'checked_in'],
      ['status_changed', 'checked_in', 'in_progress'],
      ['status_changed', 'in_progress', 'attended'],
    ]);
    expect(history.events[2]).toMatchObject({
      actorUserId: world.reception.user.id,
      actorKind: 'staff',
    });
    expect(history.events[3]).toMatchObject({ actorUserId: world.doctor.user.id });
    const [row] = await audits('appointment.status_changed');
    expect(row).toMatchObject({
      outcome: 'allow',
      resourceId: created.id,
      metadata: { from: 'in_progress', to: 'attended' },
    });
  });

  it('keeps an attended appointment in its slot and as a terminal status', async () => {
    backToStart();
    const created = await world.book(2, '10:00');
    await world.act(created, 'check-in', world.reception);
    await world.act(created, 'start', world.doctor);
    await world.act(created, 'attend', world.doctor);

    for (const action of ['confirm', 'check-in', 'no-show', 'start']) {
      const response = await world.act(created, action, world.doctor);
      expect(response.statusCode, action).toBe(409);
    }
    const cancel = await world.act(created, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });
    const move = await world.act(created, 'reschedule', world.reception, {
      expectedVersion: 4,
      local: { date: world.monday(3), time: '10:00' },
    });
    expect(cancel.statusCode).toBe(409);
    expect(move.statusCode).toBe(409);
    // The slot is still taken.
    const clash = await world.api.post(
      '/appointments',
      world.admin,
      await world.bookingBody(2, '10:15'),
    );
    expect(clash.statusCode).toBe(409);
  });

  it('only the professional of the appointment starts and attends it', async () => {
    backToStart();
    const created = await world.book(3, '10:00');
    await world.act(created, 'check-in', world.reception);
    const denied = await asTenant(runtime, world.tenant.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_event WHERE action = 'access.denied'`,
      ),
    );

    const byReception = await world.act(created, 'start', world.reception, {});
    const byAdmin = await world.act(created, 'start', world.admin, {});
    const byColleague = await world.act(created, 'start', world.colleague, {});
    const byDoctor = await world.act(created, 'start', world.doctor);

    expect([byReception.statusCode, byAdmin.statusCode, byColleague.statusCode]).toEqual([
      403, 403, 403,
    ]);
    expect(byDoctor.statusCode).toBe(200);
    const after = await asTenant(runtime, world.tenant.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_event WHERE action = 'access.denied'`,
      ),
    );
    expect((after.rows[0]?.n ?? 0) - (denied.rows[0]?.n ?? 0)).toBe(3);
  });

  it('rejects an invalid transition and leaves the appointment as it was', async () => {
    backToStart();
    const created = await world.book(4, '10:00');
    await world.act(created, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });

    const response = await world.act(created, 'check-in', world.reception);

    expect(response.statusCode).toBe(409);
    expect((await stored(created))?.status).toBe('cancelled');
  });

  it('rejects a no-show before the start and accepts it after, freeing the slot', async () => {
    backToStart();
    const created = await world.book(5, '10:00');

    const early = await world.act(created, 'no-show', world.reception, {});
    afterStart(created);
    const late = await world.act(created, 'no-show', world.reception, {});
    backToStart();

    expect(early.statusCode).toBe(400);
    expect(early.json<Problem>().errors).toEqual([
      { path: 'status', i18nKey: 'scheduling.transition.no_show_too_early' },
    ]);
    expect(late.json<AppointmentDto>().status).toBe('no_show');
    const rows = await asTenant(runtime, world.tenant.id, (tx) =>
      occupancyOf(tx, world.doctor.professionalId),
    );
    expect(rows.find((row) => row.appointment_id === created.id)?.active).toBe(false);
    expect(
      (await world.api.post('/appointments', world.admin, await world.bookingBody(5, '10:00')))
        .statusCode,
    ).toBe(201);
  });

  it('approves a pending approval into scheduled', async () => {
    backToStart();
    const created = await world.book(6, '10:00');
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .update(appointment)
        .set({ status: 'pending_approval' })
        .where(eq(appointment.id, created.id)),
    );

    const response = await world.act(created, 'approve', world.reception, {});

    expect(response.json<AppointmentDto>().status).toBe('scheduled');
  });
});

describe('optimistic concurrency', () => {
  it('rejects a stale version with 409 stale_revision, and accepts the current one', async () => {
    backToStart();
    const created = await world.book(7, '10:00');
    await world.act(created, 'confirm', world.reception, {});

    const stale = await world.act(created, 'check-in', world.reception, {
      expectedVersion: 1,
    });
    const current = await world.act(created, 'check-in', world.reception, {
      expectedVersion: 2,
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json<Problem>().code).toBe('stale_revision');
    expect(current.statusCode).toBe(200);
  });

  it('lets exactly one of two simultaneous changes through', async () => {
    backToStart();
    const created = await world.book(8, '10:00');

    const [one, two] = await Promise.all([
      world.act(created, 'confirm', world.reception, { expectedVersion: 1 }),
      world.act(created, 'check-in', world.admin, { expectedVersion: 1 }),
    ]);

    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
  });
});

describe('cancellation', () => {
  it('keeps the record, frees the slot, says who and why, and flags nothing a week ahead', async () => {
    backToStart();
    const created = await world.book(9, '10:00');

    const response = await world.act(created, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'schedule_conflict',
      note: 'Travelling',
    });

    expect(response.json<AppointmentDto>().status).toBe('cancelled');
    expect(await stored(created)).toMatchObject({
      status: 'cancelled',
      cancelledByKind: 'patient',
      cancelReason: 'schedule_conflict',
      cancelNote: 'Travelling',
      lateCancellation: false,
    });
    expect(
      (await world.api.post('/appointments', world.admin, await world.bookingBody(9, '10:00')))
        .statusCode,
    ).toBe(201);
    const [row] = await audits('appointment.cancelled');
    expect(row).toMatchObject({
      resourceId: created.id,
      metadata: { cancelledBy: 'patient', reasonCode: 'schedule_conflict', late: false },
    });
    expect(JSON.stringify(row?.metadata)).not.toContain('Travelling');
  });

  it('flags a cancellation inside the late window', async () => {
    backToStart();
    const created = await world.book(10, '10:00');
    world.setNow(new Date(Date.parse(created.startsAt) - 2 * 3_600_000));

    await world.act(created, 'cancel', world.reception, {
      cancelledBy: 'organization',
      reasonCode: 'organization_closed',
    });
    backToStart();

    expect((await stored(created))?.lateCancellation).toBe(true);
  });

  it('needs a reason code and who cancelled', async () => {
    backToStart();
    const created = await world.book(11, '10:00');

    expect((await world.act(created, 'cancel', world.reception, {})).statusCode).toBe(400);
    expect(
      (await world.act(created, 'cancel', world.reception, { cancelledBy: 'patient' })).statusCode,
    ).toBe(400);
  });
});

describe('correcting a status', () => {
  it('changes a mistaken no-show to attended with a reason, audited with the previous status', async () => {
    backToStart();
    const created = await world.book(12, '10:00');
    afterStart(created);
    await world.act(created, 'no-show', world.reception, {});

    const response = await world.act(created, 'correct', world.doctor, {
      toStatus: 'attended',
      reasonCode: 'patient_arrived_late',
      note: 'Came in through the side door',
    });
    backToStart();

    expect(response.json<AppointmentDto>().status).toBe('attended');
    const [row] = await audits('appointment.status_corrected');
    expect(row).toMatchObject({
      resourceId: created.id,
      actorUserId: world.doctor.user.id,
      metadata: { from: 'no_show', to: 'attended', reasonCode: 'patient_arrived_late' },
    });
    // The free text stays out of the audit trail and lives in the history.
    expect(JSON.stringify(row)).not.toContain('side door');
    const history = (
      await world.api.get(url(created, 'history'), world.reception)
    ).json<AppointmentHistoryResponse>();
    expect(history.events.at(-1)).toMatchObject({
      kind: 'status_corrected',
      details: { reasonCode: 'patient_arrived_late', note: 'Came in through the side door' },
    });
  });

  it('is clinical work when it goes into attended or in progress: reception and the colleague are refused', async () => {
    backToStart();
    const created = await world.book(26, '10:00');
    afterStart(created);
    await world.act(created, 'no-show', world.reception, {});
    const body = { toStatus: 'attended', reasonCode: 'patient_arrived_late' };

    const byReception = await world.act(created, 'correct', world.reception, body);
    const byAdmin = await world.act(created, 'correct', world.admin, body);
    const byColleague = await world.act(created, 'correct', world.colleague, body);
    backToStart();

    expect([byReception.statusCode, byAdmin.statusCode, byColleague.statusCode]).toEqual([
      403, 403, 403,
    ]);
    expect((await stored(created))?.status).toBe('no_show');
    // Putting a no-show back among the appointments to come is not clinical.
    const restored = await world.act(created, 'correct', world.reception, {
      toStatus: 'scheduled',
      reasonCode: 'entered_by_mistake',
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('is rejected, showing the conflicting range, when the slot was rebooked for someone else', async () => {
    backToStart();
    const created = await world.book(13, '10:00');
    afterStart(created);
    await world.act(created, 'no-show', world.reception, {});
    backToStart();
    await world.book(13, '10:00', {}, world.admin);

    const response = await world.act(created, 'correct', world.doctor, {
      toStatus: 'attended',
      reasonCode: 'recorded_late',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem & SlotConflictExtension>()).toMatchObject({
      code: 'slot_taken',
      conflict: { startsAt: created.startsAt, endsAt: created.endsAt },
    });
    expect((await stored(created))?.status).toBe('no_show');
  });

  it('needs a reason code and refuses a status that is not terminal', async () => {
    backToStart();
    const created = await world.book(14, '10:00');

    expect(
      (
        await world.act(created, 'correct', world.doctor, {
          toStatus: 'attended',
          reasonCode: 'because',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await world.act(created, 'correct', world.doctor, {
          toStatus: 'attended',
          reasonCode: 'other',
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('rescheduling and reassigning', () => {
  it('moves to a free slot, keeps the status, retains the original time and counts the move from the history', async () => {
    backToStart();
    const created = await world.book(15, '10:00');
    await world.act(created, 'confirm', world.reception, {});

    const response = await world.act(created, 'reschedule', world.reception, {
      expectedVersion: 2,
      local: { date: world.monday(16), time: '11:00' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AppointmentDto>()).toMatchObject({
      status: 'confirmed',
      startsAt: `${world.monday(16)}T14:00:00.000Z`,
      version: 3,
    });
    const history = (
      await world.api.get(url(created, 'history'), world.reception)
    ).json<AppointmentHistoryResponse>();
    expect(history.rescheduledCount).toBe(1);
    expect(history.events.at(-1)).toMatchObject({
      kind: 'rescheduled',
      details: { fromStartsAt: created.startsAt, fromProfessionalId: world.doctor.professionalId },
    });
    expect((await audits('appointment.rescheduled'))[0]).toMatchObject({ resourceId: created.id });
    // The old slot is free again.
    expect(
      (await world.api.post('/appointments', world.admin, await world.bookingBody(15, '10:00')))
        .statusCode,
    ).toBe(201);
  });

  it('rejects an occupied slot and leaves the original appointment unchanged', async () => {
    backToStart();
    const created = await world.book(17, '10:00');
    await world.book(18, '10:00');

    const response = await world.act(created, 'reschedule', world.reception, {
      expectedVersion: 1,
      local: { date: world.monday(18), time: '10:00' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('slot_taken');
    expect(await stored(created)).toMatchObject({
      startsAt: new Date(created.startsAt),
      version: 1,
    });
  });

  it('answers 409 stale_revision for a version that is no longer current', async () => {
    backToStart();
    const created = await world.book(19, '10:00');
    await world.act(created, 'confirm', world.reception, {});

    const response = await world.act(created, 'reschedule', world.reception, {
      expectedVersion: 1,
      local: { date: world.monday(20), time: '10:00' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('stale_revision');
  });

  it('reassigns to another professional at the same time', async () => {
    backToStart();
    const created = await world.book(21, '10:00');

    const response = await world.act(created, 'reschedule', world.reception, {
      expectedVersion: 1,
      professionalId: world.colleague.professionalId,
    });

    expect(response.json<AppointmentDto>()).toMatchObject({
      professionalId: world.colleague.professionalId,
      startsAt: created.startsAt,
    });
    const history = (
      await world.api.get(url(created, 'history'), world.reception)
    ).json<AppointmentHistoryResponse>();
    expect(history.events.at(-1)).toMatchObject({
      kind: 'reassigned',
      details: { fromProfessionalId: world.doctor.professionalId },
    });
    expect((await audits('appointment.reassigned'))[0]).toMatchObject({ resourceId: created.id });
  });

  it('validates the new time like a booking: hours, and nothing to change', async () => {
    backToStart();
    const created = await world.book(22, '10:00');

    const late = await world.act(created, 'reschedule', world.reception, {
      expectedVersion: 1,
      local: { date: world.monday(22), time: '16:00' },
    });
    const same = await world.act(created, 'reschedule', world.reception, {
      expectedVersion: 1,
      local: { date: world.monday(22), time: '10:00' },
    });
    const empty = await world.act(created, 'reschedule', world.reception, {
      expectedVersion: 1,
    });

    expect(late.json<Problem>().errors).toEqual([
      { path: 'startsAt', i18nKey: 'scheduling.booking.outside_working_hours' },
    ]);
    expect(same.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
  });

  it('answers not found for an appointment of another organization', async () => {
    expect(
      (
        await world.api.post(
          '/appointments/0190a000-0000-7000-8000-0000000000aa/confirm',
          world.reception,
          { expectedVersion: 1 },
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('a read-only organization', () => {
  async function setStatus(status: 'active' | 'read_only') {
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set(
          status === 'read_only'
            ? { status, readOnlySince: new Date() }
            : { status, readOnlySince: null },
        )
        .where(eq(tenantTable.id, world.tenant.id)),
    );
  }

  it('refuses booking, rescheduling, check-in and corrections with 402, and allows cancelling', async () => {
    backToStart();
    const toCancel = await world.book(23, '10:00');
    const toKeep = await world.book(24, '10:00');
    await setStatus('read_only');
    try {
      const refused = await Promise.all([
        world.api.post('/appointments', world.reception, await world.bookingBody(25, '10:00')),
        world.act(toKeep, 'reschedule', world.reception, {
          expectedVersion: 1,
          local: { date: world.monday(25), time: '11:00' },
        }),
        world.act(toKeep, 'check-in', world.reception, {}),
        world.act(toKeep, 'confirm', world.reception, {}),
        world.act(toKeep, 'correct', world.reception, {
          toStatus: 'attended',
          reasonCode: 'other',
        }),
      ]);
      const cancel = await world.act(toCancel, 'cancel', world.reception, {
        cancelledBy: 'patient',
        reasonCode: 'illness',
      });
      const read = await world.api.get(url(toKeep, 'history'), world.reception);

      expect(refused.map((response) => response.statusCode)).toEqual([402, 402, 402, 402, 402]);
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json<AppointmentDto>().status).toBe('cancelled');
      expect(read.statusCode).toBe(200);
    } finally {
      await setStatus('active');
    }
  });
});
