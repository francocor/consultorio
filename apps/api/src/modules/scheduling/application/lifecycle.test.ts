import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  type CorrectionReason,
} from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../platform/http/problem.js';
import {
  createFakeSchedulingPorts,
  type FakeSchedulingState,
} from '../../../testing/scheduling-ports.js';
import { AccessRefused } from '../../access/index.js';

import { correctStatus, rescheduleAppointment, transitionAppointment } from './lifecycle.js';
import { SlotTakenError, type BookActor } from './placement.js';
import type { AppointmentRecord } from './ports.js';

const BA = 'America/Argentina/Buenos_Aires';
const DOCTOR = 'doctor-1';
const COLLEAGUE = 'doctor-2';
const CENTRO = 'centro';
const USER = 'user-reception';
const NOW = new Date('2026-07-13T12:00:00.000Z'); // Monday 09:00 local
const utc = (text: string) => Date.parse(text);

const auditActor = {
  userId: USER,
  actingRole: 'reception' as const,
  ip: null,
  userAgent: null,
  requestId: null,
};

function actor(
  options: { permissions?: string[]; professionalId?: string | null } = {},
): BookActor {
  return {
    userId: USER,
    permissions: new Set(['scheduling.book', 'scheduling.checkin', ...(options.permissions ?? [])]),
    professionalId: options.professionalId ?? null,
  };
}

function appointment(overrides: Partial<AppointmentRecord> = {}): AppointmentRecord {
  return {
    id: 'appt-1',
    patientId: 'patient-1',
    professionalId: DOCTOR,
    locationId: CENTRO,
    appointmentTypeId: 'type-30',
    startsAt: new Date('2026-07-20T13:00:00.000Z'), // next Monday 10:00 local
    endsAt: new Date('2026-07-20T13:30:00.000Z'),
    bufferMinutes: 0,
    lane: 1,
    status: 'scheduled',
    source: 'staff',
    bookedBy: USER,
    identityConfirmed: true,
    identityConfirmedBy: null,
    identityConfirmation: null,
    outOfHours: false,
    overrideReason: null,
    videoRoom: null,
    seriesId: null,
    seriesIndex: null,
    version: 1,
    ...overrides,
  };
}

function world(
  record: AppointmentRecord = appointment(),
  overrides: Partial<FakeSchedulingState> = {},
) {
  return createFakeSchedulingPorts({
    professionals: new Map([
      [
        DOCTOR,
        { id: DOCTOR, membershipId: 'm1', status: 'active', maxSimultaneous: 1, specialties: [] },
      ],
      [
        COLLEAGUE,
        {
          id: COLLEAGUE,
          membershipId: 'm2',
          status: 'active',
          maxSimultaneous: 1,
          specialties: [],
        },
      ],
    ]),
    locations: new Map([[CENTRO, { id: CENTRO, timeZone: BA, active: true }]]),
    types: new Map([
      [
        'type-30',
        {
          id: 'type-30',
          durationMinutes: 30,
          bufferMinutes: 0,
          active: true,
          requiresApproval: false,
          professionalIds: [],
          specialties: [],
        },
      ],
    ]),
    patients: new Map([['patient-1', { id: 'patient-1', status: 'active' }]]),
    appointments: new Map([[record.id, record]]),
    // Mondays 09:00-13:00 for both professionals.
    weekly: [{ locationId: CENTRO, weekday: 1, startMinute: 540, endMinute: 780 }],
    ...overrides,
  });
}

const thrown = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

type Action = Parameters<typeof transitionAppointment>[1]['action'];

const move = (
  ports: ReturnType<typeof world>['ports'],
  action: Action,
  who: BookActor = actor(),
  extra: Partial<Parameters<typeof transitionAppointment>[1]> = {},
  now = NOW,
) =>
  transitionAppointment(ports, {
    appointmentId: 'appt-1',
    action,
    actor: who,
    auditActor,
    now,
    ...extra,
    expectedVersion: extra.expectedVersion ?? 1,
  });

describe('the ordinary path through the day', () => {
  it('confirm, check in, start and attend, each written to the history and the audit trail', async () => {
    const { ports, state } = world();
    const doctor = actor({ professionalId: DOCTOR });

    // Each step names the version the previous one produced.
    await move(ports, 'confirm', actor(), { expectedVersion: 1 });
    await move(ports, 'check_in', actor(), { expectedVersion: 2 });
    await move(ports, 'start', doctor, { expectedVersion: 3 });
    const done = await move(ports, 'attend', doctor, { expectedVersion: 4 });

    expect(done.status).toBe('attended');
    expect(done.version).toBe(5);
    expect(state.events.map((event) => [event.kind, event.fromStatus, event.toStatus])).toEqual([
      ['status_changed', 'scheduled', 'confirmed'],
      ['status_changed', 'confirmed', 'checked_in'],
      ['status_changed', 'checked_in', 'in_progress'],
      ['status_changed', 'in_progress', 'attended'],
    ]);
    expect(state.audits.map((audit) => audit.action)).toEqual([
      'appointment.status_changed',
      'appointment.status_changed',
      'appointment.status_changed',
      'appointment.status_changed',
    ]);
    expect(state.audits[1]).toMatchObject({
      resourceId: 'appt-1',
      metadata: { from: 'confirmed', to: 'checked_in' },
    });
  });

  it('lets reception skip the confirmation and check in a scheduled appointment', async () => {
    const { ports } = world();

    expect((await move(ports, 'check_in')).status).toBe('checked_in');
  });

  it('approves a pending approval into scheduled', async () => {
    const { ports } = world(appointment({ status: 'pending_approval' }));

    expect((await move(ports, 'approve')).status).toBe('scheduled');
  });

  it('only the professional of the appointment starts and finishes it', async () => {
    const checkedIn = () => world(appointment({ status: 'checked_in' }));

    expect(await thrown(move(checkedIn().ports, 'start', actor()))).toBeInstanceOf(AccessRefused);
    expect(
      await thrown(move(checkedIn().ports, 'start', actor({ professionalId: COLLEAGUE }))),
    ).toBeInstanceOf(AccessRefused);
    expect((await move(checkedIn().ports, 'start', actor({ professionalId: DOCTOR }))).status).toBe(
      'in_progress',
    );
  });
});

describe('transitions that are not allowed', () => {
  const TARGET: Record<Action, AppointmentStatus> = {
    confirm: 'confirmed',
    check_in: 'checked_in',
    start: 'in_progress',
    attend: 'attended',
    no_show: 'no_show',
    cancel: 'cancelled',
    approve: 'scheduled',
  };
  const ACTIONS = Object.keys(TARGET) as Action[];
  const ALLOWED: Record<AppointmentStatus, readonly Action[]> = {
    pending_approval: ['approve', 'cancel'],
    scheduled: ['confirm', 'check_in', 'no_show', 'cancel'],
    confirmed: ['check_in', 'no_show', 'cancel'],
    checked_in: ['start', 'no_show', 'cancel'],
    in_progress: ['attend'],
    attended: [],
    no_show: [],
    cancelled: [],
  };
  const PAIRS = APPOINTMENT_STATUSES.flatMap((status) =>
    ACTIONS.map((action) => [status, action] as const),
  );

  it.each(PAIRS)('%s with %s', async (status, action) => {
    // Far in the past, so a no-show is never "too early" here.
    const record = appointment({
      status,
      startsAt: new Date('2026-07-01T13:00:00.000Z'),
      endsAt: new Date('2026-07-01T13:30:00.000Z'),
    });
    const { ports, state } = world(record);
    const doctor = actor({ professionalId: DOCTOR });
    const extra =
      action === 'cancel'
        ? { cancellation: { cancelledBy: 'patient' as const, reasonCode: 'illness' as const } }
        : {};

    const result = await thrown(move(ports, action, doctor, extra));

    if (ALLOWED[status].includes(action)) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toBeInstanceOf(AppError);
      expect((result as AppError).code).toBe('conflict');
      expect(state.updates).toEqual([]);
    }
  });

  it('answers not found for an appointment of another organization', async () => {
    const { ports } = world();

    const error = await thrown(
      transitionAppointment(ports, {
        appointmentId: 'nobody',
        action: 'confirm',
        actor: actor(),
        auditActor,
        now: NOW,
        expectedVersion: 1,
      }),
    );

    expect((error as AppError).code).toBe('not_found');
  });
});

describe('optimistic concurrency', () => {
  it('rejects a stale version with 409 stale_revision and changes nothing', async () => {
    const { ports, state } = world(appointment({ version: 3 }));

    const error = await thrown(move(ports, 'confirm', actor(), { expectedVersion: 2 }));

    expect((error as AppError).code).toBe('stale_revision');
    expect(state.updates).toEqual([]);
  });

  it('refuses a change that names no version, in every write of an appointment', async () => {
    const noVersion = { expectedVersion: undefined } as unknown as { expectedVersion: number };
    const transition = world();
    const correction = world(appointment({ status: 'no_show' }));
    const move = world();

    const results = await Promise.all([
      thrown(
        transitionAppointment(transition.ports, {
          appointmentId: 'appt-1',
          action: 'confirm',
          actor: actor(),
          auditActor,
          now: NOW,
          ...noVersion,
        }),
      ),
      thrown(
        correctStatus(correction.ports, {
          appointmentId: 'appt-1',
          toStatus: 'attended',
          reasonCode: 'other',
          actor: actor(),
          auditActor,
          now: NOW,
          ...noVersion,
        }),
      ),
      thrown(
        rescheduleAppointment(move.ports, {
          appointmentId: 'appt-1',
          local: { date: '2026-07-27', time: '11:00' },
          actor: actor(),
          auditActor,
          now: NOW,
          ...noVersion,
        }),
      ),
    ]);

    expect(results.map((error) => (error as AppError).code)).toEqual([
      'stale_revision',
      'stale_revision',
      'stale_revision',
    ]);
    expect(transition.state.updates).toEqual([]);
    expect(correction.state.updates).toEqual([]);
    expect(move.state.updates).toEqual([]);
  });

  it('accepts the current version', async () => {
    const { ports } = world(appointment({ version: 3 }));

    expect((await move(ports, 'confirm', actor(), { expectedVersion: 3 })).version).toBe(4);
  });
});

describe('no-show', () => {
  it('is refused before the start time, with a message about the start', async () => {
    const { ports, state } = world(
      appointment({
        startsAt: new Date('2026-07-13T15:00:00.000Z'),
        endsAt: new Date('2026-07-13T15:30:00.000Z'),
      }),
    );

    const error = await thrown(move(ports, 'no_show'));

    expect((error as AppError).code).toBe('validation_failed');
    expect((error as AppError).fieldErrors).toEqual([
      { path: 'status', i18nKey: 'scheduling.transition.no_show_too_early' },
    ]);
    expect(state.updates).toEqual([]);
  });

  it('is accepted once the start time has passed, and frees the slot', async () => {
    const record = appointment({
      startsAt: new Date('2026-07-13T11:00:00.000Z'),
      endsAt: new Date('2026-07-13T11:30:00.000Z'),
    });
    const { ports } = world(record);

    expect((await move(ports, 'no_show')).status).toBe('no_show');
  });
});

describe('cancellation', () => {
  const cancel = (
    ports: ReturnType<typeof world>['ports'],
    extra: { cancelledBy?: 'patient' | 'professional' | 'organization'; note?: string } = {},
    now = NOW,
  ) =>
    move(
      ports,
      'cancel',
      actor(),
      {
        cancellation: {
          cancelledBy: extra.cancelledBy ?? 'patient',
          reasonCode: 'illness',
          ...(extra.note ? { note: extra.note } : {}),
        },
      },
      now,
    );

  it('keeps the record, says who cancelled and why, and is not late a week ahead', async () => {
    const { ports, state } = world();

    const cancelled = await cancel(ports, { note: 'Fever' });

    expect(cancelled.status).toBe('cancelled');
    expect(state.updates[0]?.patch).toMatchObject({
      status: 'cancelled',
      cancelledByKind: 'patient',
      cancelReason: 'illness',
      cancelNote: 'Fever',
      lateCancellation: false,
    });
    expect(state.audits[0]).toMatchObject({
      action: 'appointment.cancelled',
      metadata: { cancelledBy: 'patient', reasonCode: 'illness', late: false },
    });
    // The free text stays out of the audit trail.
    expect(JSON.stringify(state.audits[0])).not.toContain('Fever');
  });

  it('flags a cancellation inside the late window (24 hours by default)', async () => {
    const record = appointment({
      startsAt: new Date('2026-07-13T14:00:00.000Z'),
      endsAt: new Date('2026-07-13T14:30:00.000Z'),
    });
    const { ports, state } = world(record);

    await cancel(ports);

    expect(state.updates[0]?.patch.lateCancellation).toBe(true);
    expect(state.audits[0]?.metadata).toMatchObject({ late: true });
  });

  it('uses the window of the organization', async () => {
    const record = appointment({
      startsAt: new Date('2026-07-14T10:00:00.000Z'),
      endsAt: new Date('2026-07-14T10:30:00.000Z'),
    }); // 22 hours ahead
    const wide = world(record, { lateWindowHours: 48 });
    const narrow = world(record, { lateWindowHours: 12 });

    await cancel(wide.ports);
    await cancel(narrow.ports);

    expect(wide.state.updates[0]?.patch.lateCancellation).toBe(true);
    expect(narrow.state.updates[0]?.patch.lateCancellation).toBe(false);
  });

  it('revokes the video link of a virtual appointment', async () => {
    const { ports, state } = world(appointment({ videoRoom: 'room-1' }));

    await cancel(ports);

    expect(state.updates[0]?.patch.videoRoom).toBeNull();
  });

  it('refuses to cancel an attended appointment', async () => {
    const { ports } = world(appointment({ status: 'attended' }));

    expect(((await thrown(cancel(ports))) as AppError).code).toBe('conflict');
  });

  it('dismisses the open identity review of the appointment it cancels', async () => {
    const { ports, state } = world(appointment({ identityConfirmed: false }));

    await cancel(ports);

    expect(state.closedItems).toContainEqual({
      kind: 'identity_review',
      subjectId: 'appt-1',
      status: 'dismissed',
      resolution: 'appointment_cancelled',
    });
  });

  it('dismisses the pending approval item of the appointment it cancels', async () => {
    const { ports, state } = world(appointment({ status: 'pending_approval' }));

    await cancel(ports);

    expect(state.closedItems).toContainEqual({
      kind: 'pending_approval',
      subjectId: 'appt-1',
      status: 'dismissed',
      resolution: 'appointment_cancelled',
    });
  });

  it('closes nothing when the appointment is not cancelled', async () => {
    const { ports, state } = world(appointment({ identityConfirmed: false }));

    await move(ports, 'confirm');

    expect(state.closedItems).toEqual([]);
  });

  it('needs the cancellation details', async () => {
    const { ports } = world();

    const error = await thrown(move(ports, 'cancel'));

    expect((error as AppError).code).toBe('validation_failed');
  });
});

describe('correcting a terminal status', () => {
  // The appointment's own professional by default: a correction into the clinical statuses is theirs.
  const correct = (
    ports: ReturnType<typeof world>['ports'],
    toStatus: AppointmentStatus,
    extra: { who?: BookActor; reasonCode?: CorrectionReason; note?: string } = {},
  ) =>
    correctStatus(ports, {
      appointmentId: 'appt-1',
      toStatus,
      reasonCode: extra.reasonCode ?? 'patient_arrived_late',
      ...(extra.note === undefined ? {} : { note: extra.note }),
      actor: extra.who ?? actor({ professionalId: DOCTOR }),
      auditActor,
      now: NOW,
      expectedVersion: 1,
    });
  const mistakenNoShow = () =>
    appointment({
      status: 'no_show',
      startsAt: new Date('2026-07-13T11:00:00.000Z'),
      endsAt: new Date('2026-07-13T11:30:00.000Z'),
    });

  it('changes a mistaken no-show to attended and audits the previous status, reason code and actor', async () => {
    const { ports, state } = world(mistakenNoShow());

    const corrected = await correct(ports, 'attended');

    expect(corrected.status).toBe('attended');
    expect(state.events[0]).toMatchObject({
      kind: 'status_corrected',
      fromStatus: 'no_show',
      toStatus: 'attended',
      details: { reasonCode: 'patient_arrived_late' },
    });
    expect(state.audits[0]).toMatchObject({
      action: 'appointment.status_corrected',
      actor: { userId: USER },
      metadata: { from: 'no_show', to: 'attended', reasonCode: 'patient_arrived_late' },
    });
  });

  it('keeps the free text out of the audit trail and in the history only', async () => {
    const { ports, state } = world(mistakenNoShow());

    await correct(ports, 'attended', { note: 'Came in through the side door' });

    expect(JSON.stringify(state.audits)).not.toContain('side door');
    expect(state.events[0]?.details).toEqual({
      reasonCode: 'patient_arrived_late',
      note: 'Came in through the side door',
    });
  });

  it.each(['attended', 'in_progress'] as const)(
    'needs the appointment’s own professional to correct into %s',
    async (target) => {
      const reception = world(mistakenNoShow());
      const colleague = world(mistakenNoShow());
      const admin = world(mistakenNoShow());

      const byReception = await thrown(correct(reception.ports, target, { who: actor() }));
      const byColleague = await thrown(
        correct(colleague.ports, target, { who: actor({ professionalId: COLLEAGUE }) }),
      );
      const byAdmin = await thrown(
        correct(admin.ports, target, { who: actor({ permissions: ['scheduling.register_past'] }) }),
      );

      for (const error of [byReception, byColleague, byAdmin]) {
        expect(error).toBeInstanceOf(AccessRefused);
        expect((error as AccessRefused).reason).toBe('not_the_appointment_professional');
      }
      for (const { state } of [reception, colleague, admin]) {
        expect(state.updates).toEqual([]);
        expect(state.audits).toEqual([]);
      }
    },
  );

  it('leaves the corrections that are not clinical to whoever may check in', async () => {
    const restored = world(appointment({ status: 'cancelled' }));
    const missed = world(appointment({ status: 'attended' }));

    const toScheduled = await correct(restored.ports, 'scheduled', { who: actor() });
    const toNoShow = await correct(missed.ports, 'no_show', { who: actor() });

    expect(toScheduled.status).toBe('scheduled');
    expect(toNoShow.status).toBe('no_show');
  });

  it('is rejected when the slot was rebooked for someone else, showing the conflicting range', async () => {
    const record = appointment({
      status: 'no_show',
      startsAt: new Date('2026-07-13T11:00:00.000Z'),
      endsAt: new Date('2026-07-13T11:30:00.000Z'),
    });
    const { ports, state } = world(record, {
      occupancies: [
        {
          id: 'other',
          kind: 'appointment',
          locationId: CENTRO,
          lane: 1,
          start: utc('2026-07-13T11:00:00Z'),
          end: utc('2026-07-13T11:30:00Z'),
        },
      ],
    });

    const error = await thrown(correct(ports, 'attended'));

    expect(error).toBeInstanceOf(SlotTakenError);
    expect((error as SlotTakenError).conflict).toEqual({
      start: utc('2026-07-13T11:00:00Z'),
      end: utc('2026-07-13T11:30:00Z'),
    });
    expect(state.updates).toEqual([]);
  });

  it('does not look for room when the corrected status does not take time', async () => {
    const record = appointment({
      status: 'attended',
      startsAt: new Date('2026-07-13T11:00:00.000Z'),
      endsAt: new Date('2026-07-13T11:30:00.000Z'),
    });
    const { ports } = world(record, {
      occupancies: [
        {
          id: 'other',
          kind: 'appointment',
          locationId: CENTRO,
          lane: 1,
          start: utc('2026-07-13T11:00:00Z'),
          end: utc('2026-07-13T11:30:00Z'),
        },
      ],
    });

    expect((await correct(ports, 'no_show')).status).toBe('no_show');
  });

  it('gives the lane back and clears the cancellation when a cancelled appointment is restored', async () => {
    const { ports, state } = world(appointment({ status: 'cancelled' }));

    await correct(ports, 'scheduled', { reasonCode: 'entered_by_mistake' });

    expect(state.updates[0]?.patch).toMatchObject({
      status: 'scheduled',
      lane: 1,
      cancelledByKind: null,
      cancelReason: null,
      cancelledAt: null,
    });
  });

  it('answers an overlap the database refuses with the conflict and the next free slots', async () => {
    const { ports, state } = world(
      appointment({
        status: 'no_show',
        startsAt: new Date('2026-07-13T11:00:00.000Z'),
        endsAt: new Date('2026-07-13T11:30:00.000Z'),
      }),
    );
    state.refuseOverlapOn.add('updateAppointment');

    const error = await thrown(correct(ports, 'attended'));

    expect(error).toBeInstanceOf(SlotTakenError);
    expect((error as SlotTakenError).nextSlots.length).toBeGreaterThan(0);
  });

  it('refuses to correct a status that is not terminal', async () => {
    const { ports } = world(appointment({ status: 'scheduled' }));

    expect(((await thrown(correct(ports, 'attended'))) as AppError).code).toBe('conflict');
  });
});

describe('rescheduling', () => {
  const reschedule = (
    ports: ReturnType<typeof world>['ports'],
    extra: Partial<Parameters<typeof rescheduleAppointment>[1]> = {},
  ) =>
    rescheduleAppointment(ports, {
      appointmentId: 'appt-1',
      expectedVersion: 1,
      actor: actor(),
      auditActor,
      now: NOW,
      local: { date: '2026-07-27', time: '11:00' },
      ...extra,
    });

  it('moves to a free slot, keeps the status, and records the original time', async () => {
    const { ports, state } = world();

    const moved = await reschedule(ports);

    expect(moved).toMatchObject({
      status: 'scheduled',
      startsAt: '2026-07-27T14:00:00.000Z',
      endsAt: '2026-07-27T14:30:00.000Z',
      version: 2,
    });
    expect(state.events[0]).toMatchObject({
      kind: 'rescheduled',
      details: { fromStartsAt: '2026-07-20T13:00:00.000Z', fromProfessionalId: DOCTOR },
    });
    expect(state.audits[0]).toMatchObject({ action: 'appointment.rescheduled' });
  });

  it('keeps the appointment unchanged when the new slot is occupied', async () => {
    const { ports, state } = world(appointment(), {
      occupancies: [
        {
          id: 'other',
          kind: 'appointment',
          locationId: CENTRO,
          lane: 1,
          start: utc('2026-07-27T14:00:00Z'),
          end: utc('2026-07-27T14:30:00Z'),
        },
      ],
    });

    const error = await thrown(reschedule(ports));

    expect(error).toBeInstanceOf(SlotTakenError);
    expect(state.updates).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it('answers an overlap the database refuses with the conflict and the next free slots', async () => {
    const { ports, state } = world();
    state.refuseOverlapOn.add('updateAppointment');

    const error = await thrown(reschedule(ports));

    expect(error).toBeInstanceOf(SlotTakenError);
    expect((error as SlotTakenError).nextSlots.length).toBeGreaterThan(0);
  });

  it('does not count its own old slot against the move (shifting by ten minutes)', async () => {
    const { ports } = world(appointment(), {
      occupancies: [
        {
          id: 'appt-1',
          kind: 'appointment',
          locationId: CENTRO,
          lane: 1,
          start: utc('2026-07-20T13:00:00Z'),
          end: utc('2026-07-20T13:30:00Z'),
        },
      ],
    });

    const moved = await reschedule(ports, { local: { date: '2026-07-20', time: '10:10' } });

    expect(moved.startsAt).toBe('2026-07-20T13:10:00.000Z');
  });

  it('applies the same hours rule as a booking', async () => {
    const { ports } = world();

    const error = await thrown(reschedule(ports, { local: { date: '2026-07-27', time: '16:00' } }));

    expect((error as AppError).fieldErrors[0]?.i18nKey).toBe(
      'scheduling.booking.outside_working_hours',
    );
  });

  it('refuses an attended, cancelled or no-show appointment, and one already checked in', async () => {
    for (const status of [
      'attended',
      'cancelled',
      'no_show',
      'checked_in',
      'in_progress',
    ] as const) {
      const { ports } = world(appointment({ status }));

      expect(((await thrown(reschedule(ports))) as AppError).code).toBe('conflict');
    }
  });

  it('rejects a stale version with 409 stale_revision', async () => {
    const { ports, state } = world(appointment({ version: 4 }));

    const error = await thrown(reschedule(ports, { expectedVersion: 3 }));

    expect((error as AppError).code).toBe('stale_revision');
    expect(state.updates).toEqual([]);
  });

  it('changes the professional as a reassignment, at the same time', async () => {
    const { ports, state } = world();

    const moved = await reschedule(ports, { local: undefined, professionalId: COLLEAGUE });

    expect(moved.professionalId).toBe(COLLEAGUE);
    expect(moved.startsAt).toBe('2026-07-20T13:00:00.000Z');
    expect(state.events[0]).toMatchObject({
      kind: 'reassigned',
      details: { fromProfessionalId: DOCTOR },
    });
    expect(state.audits[0]?.action).toBe('appointment.reassigned');
  });

  it('does not reassign to a professional who is busy then', async () => {
    const { ports } = world(appointment(), {
      occupancies: [
        {
          id: 'other',
          kind: 'appointment',
          locationId: CENTRO,
          lane: 1,
          start: utc('2026-07-20T13:00:00Z'),
          end: utc('2026-07-20T13:30:00Z'),
        },
      ],
    });

    expect(
      await thrown(reschedule(ports, { local: undefined, professionalId: COLLEAGUE })),
    ).toBeInstanceOf(SlotTakenError);
  });

  it('rotates the video room of a virtual appointment so the old link stops working', async () => {
    const { ports, state } = world(appointment({ videoRoom: 'room-1' }));

    await reschedule(ports);

    const room = state.updates[0]?.patch.videoRoom;
    expect(room).toBeTruthy();
    expect(room).not.toBe('room-1');
  });

  it('leaves a physical appointment without a room', async () => {
    const { ports, state } = world();

    await reschedule(ports);

    expect(state.updates[0]?.patch.videoRoom ?? null).toBeNull();
  });

  it('counts the moves from the history, not from a status', async () => {
    const { ports, state } = world();

    const moved = await reschedule(ports);

    expect(moved.status).toBe('scheduled');
    expect(state.events.filter((event) => event.kind === 'rescheduled')).toHaveLength(1);
  });
});
