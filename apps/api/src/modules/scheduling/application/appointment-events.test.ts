import { describe, expect, it } from 'vitest';

import { createFakeSchedulingPorts } from '../../../testing/scheduling-ports.js';

import { bookAppointment } from './book-appointment.js';
import { correctStatus, rescheduleAppointment, transitionAppointment } from './lifecycle.js';
import type { BookActor } from './placement.js';
import type { AppointmentRecord, ProfessionalRecord } from './ports.js';

const BA = 'America/Argentina/Buenos_Aires';
const DOCTOR = 'doctor-1';
const COLLEAGUE = 'doctor-2';
const CENTRO = 'centro';
const NORTE = 'norte';
const USER = 'user-reception';
const NOW = new Date('2026-07-13T12:00:00.000Z'); // Monday 09:00 local

const auditActor = {
  userId: USER,
  actingRole: 'reception' as const,
  ip: null,
  userAgent: null,
  requestId: null,
};

const actor: BookActor = {
  userId: USER,
  permissions: new Set(['scheduling.book', 'scheduling.checkin']),
  professionalId: null,
};

function stored(overrides: Partial<AppointmentRecord> = {}): AppointmentRecord {
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
    source: 'online',
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

function world(record: AppointmentRecord = stored()) {
  const professional = (id: string, membershipId: string): [string, ProfessionalRecord] => [
    id,
    { id, membershipId, status: 'active', maxSimultaneous: 1, specialties: [] },
  ];
  return createFakeSchedulingPorts({
    professionals: new Map([professional(DOCTOR, 'm1'), professional(COLLEAGUE, 'm2')]),
    locations: new Map([
      [CENTRO, { id: CENTRO, timeZone: BA, active: true }],
      [NORTE, { id: NORTE, timeZone: BA, active: true }],
    ]),
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
    // Mondays 09:00-13:00 in both places.
    weekly: [
      { locationId: CENTRO, weekday: 1, startMinute: 540, endMinute: 780 },
      { locationId: NORTE, weekday: 1, startMinute: 540, endMinute: 780 },
    ],
  });
}

const transition = (
  ports: ReturnType<typeof world>['ports'],
  action: Parameters<typeof transitionAppointment>[1]['action'],
  extra: Partial<Parameters<typeof transitionAppointment>[1]> = {},
) =>
  transitionAppointment(ports, {
    appointmentId: 'appt-1',
    action,
    actor,
    auditActor,
    now: NOW,
    expectedVersion: 1,
    ...extra,
  });

const cancellation = {
  cancelledBy: 'patient' as const,
  reasonCode: 'patient_request' as const,
};

describe('the appointment events scheduling publishes', () => {
  it('publishes one created event when an appointment is booked, with what a subscriber needs', async () => {
    const { ports, state } = world();

    await bookAppointment(ports, {
      request: {
        patientId: 'patient-1',
        professionalId: DOCTOR,
        locationId: CENTRO,
        appointmentTypeId: 'type-30',
        startsAt: '2026-07-20T14:00:00.000Z',
      },
      actor,
      auditActor,
      now: NOW,
    });

    expect(state.published).toHaveLength(1);
    expect(state.published[0]).toMatchObject({
      kind: 'created',
      appointment: {
        patientId: 'patient-1',
        professionalId: DOCTOR,
        locationId: CENTRO,
        appointmentTypeId: 'type-30',
        status: 'scheduled',
        source: 'staff',
        version: 1,
      },
    });
    const first = state.published[0];
    expect(first?.kind === 'created' && first.appointment.startsAt).toEqual(
      new Date('2026-07-20T14:00:00.000Z'),
    );
  });

  it('publishes a status_changed event for a confirmation and no slot_freed', async () => {
    const { ports, state } = world();

    await transition(ports, 'confirm');

    expect(state.published.map((event) => event.kind)).toEqual(['status_changed']);
    expect(state.published[0]).toMatchObject({
      kind: 'status_changed',
      fromStatus: 'scheduled',
      appointment: { appointmentId: 'appt-1', status: 'confirmed', version: 2 },
    });
  });

  it('publishes cancelled and then slot_freed when an appointment is cancelled', async () => {
    const { ports, state } = world();

    await transition(ports, 'cancel', { cancellation });

    expect(state.published.map((event) => event.kind)).toEqual(['cancelled', 'slot_freed']);
    expect(state.published[0]).toMatchObject({
      kind: 'cancelled',
      fromStatus: 'scheduled',
      cancelledBy: 'patient',
      appointment: { appointmentId: 'appt-1', status: 'cancelled', version: 2 },
    });
    expect(state.published[1]).toMatchObject({
      kind: 'slot_freed',
      cause: 'cancelled',
      slot: { professionalId: DOCTOR, locationId: CENTRO },
      appointment: { appointmentId: 'appt-1', appointmentTypeId: 'type-30' },
    });
    const freed = state.published[1];
    expect(freed?.kind === 'slot_freed' && freed.slot.startsAt).toEqual(
      new Date('2026-07-20T13:00:00.000Z'),
    );
  });

  it('does not free a slot when the appointment was attended or missed: the time already passed', async () => {
    const { ports, state } = world(stored({ status: 'in_progress' }));

    await transition(ports, 'attend', { actor: { ...actor, professionalId: DOCTOR } });

    expect(state.published.map((event) => event.kind)).toEqual(['status_changed']);
  });

  it('publishes rescheduled and slot_freed with the place the appointment left', async () => {
    const { ports, state } = world();

    await rescheduleAppointment(ports, {
      appointmentId: 'appt-1',
      expectedVersion: 1,
      startsAt: '2026-07-20T15:00:00.000Z',
      actor,
      auditActor,
      now: NOW,
    });

    expect(state.published.map((event) => event.kind)).toEqual(['rescheduled', 'slot_freed']);
    const [moved, freed] = state.published;
    expect(moved).toMatchObject({
      kind: 'rescheduled',
      appointment: { appointmentId: 'appt-1', version: 2 },
      previous: { professionalId: DOCTOR, locationId: CENTRO },
    });
    expect(moved?.kind === 'rescheduled' && moved.appointment.startsAt).toEqual(
      new Date('2026-07-20T15:00:00.000Z'),
    );
    expect(moved?.kind === 'rescheduled' && moved.previous.startsAt).toEqual(
      new Date('2026-07-20T13:00:00.000Z'),
    );
    expect(freed).toMatchObject({
      kind: 'slot_freed',
      cause: 'rescheduled',
      slot: { professionalId: DOCTOR, locationId: CENTRO },
    });
    expect(freed?.kind === 'slot_freed' && freed.slot.startsAt).toEqual(
      new Date('2026-07-20T13:00:00.000Z'),
    );
  });

  it('publishes reassigned when the professional changes, and frees the first professional slot', async () => {
    const { ports, state } = world();

    await rescheduleAppointment(ports, {
      appointmentId: 'appt-1',
      expectedVersion: 1,
      professionalId: COLLEAGUE,
      actor,
      auditActor,
      now: NOW,
    });

    expect(state.published.map((event) => event.kind)).toEqual(['reassigned', 'slot_freed']);
    expect(state.published[0]).toMatchObject({
      previous: { professionalId: DOCTOR },
      appointment: { professionalId: COLLEAGUE },
    });
    expect(state.published[1]).toMatchObject({
      cause: 'reassigned',
      slot: { professionalId: DOCTOR, locationId: CENTRO },
    });
  });

  it('frees the old location when only the location changes', async () => {
    const { ports, state } = world();

    await rescheduleAppointment(ports, {
      appointmentId: 'appt-1',
      expectedVersion: 1,
      locationId: NORTE,
      actor,
      auditActor,
      now: NOW,
    });

    expect(state.published.map((event) => event.kind)).toEqual(['rescheduled', 'slot_freed']);
    expect(state.published[1]).toMatchObject({ slot: { locationId: CENTRO } });
  });

  it('publishes status_changed for a correction, never a slot_freed', async () => {
    const { ports, state } = world(stored({ status: 'no_show' }));

    await correctStatus(ports, {
      appointmentId: 'appt-1',
      toStatus: 'confirmed',
      reasonCode: 'entered_by_mistake',
      actor: { ...actor, permissions: new Set([...actor.permissions, 'scheduling.checkin']) },
      auditActor,
      now: NOW,
      expectedVersion: 1,
    });

    expect(state.published.map((event) => event.kind)).toEqual(['status_changed']);
    expect(state.published[0]).toMatchObject({ fromStatus: 'no_show' });
  });

  it('publishes nothing when the action is refused', async () => {
    const { ports, state } = world(stored({ status: 'attended' }));

    await expect(transition(ports, 'cancel', { cancellation })).rejects.toThrow();

    expect(state.published).toEqual([]);
  });
});
