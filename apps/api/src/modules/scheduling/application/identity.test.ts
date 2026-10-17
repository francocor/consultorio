import { describe, expect, it } from 'vitest';

import { type AppError } from '../../../platform/http/problem.js';
import {
  createFakeSchedulingPorts,
  type FakeSchedulingState,
} from '../../../testing/scheduling-ports.js';
import { AccessRefused } from '../../access/index.js';

import { bookAppointment } from './book-appointment.js';
import { confirmIdentity, detachPatient } from './identity.js';
import { transitionAppointment } from './lifecycle.js';
import type { BookActor } from './placement.js';
import type { AppointmentRecord } from './ports.js';

const BA = 'America/Argentina/Buenos_Aires';
const B = 'professional-b';
const C = 'professional-c';
const CENTRO = 'centro';
const USER_RECEPTION = 'user-reception';
const USER_B = 'user-b';
const NOW = new Date('2026-07-13T12:00:00.000Z');

const auditActor = (userId: string) => ({
  userId,
  actingRole: 'reception' as const,
  ip: null,
  userAgent: null,
  requestId: null,
});

function actor(userId: string, professionalId: string | null = null): BookActor {
  return {
    userId,
    permissions: new Set(['scheduling.book', 'scheduling.checkin', 'worklist.manage']),
    professionalId,
  };
}
const reception = actor(USER_RECEPTION);
const asB = actor(USER_B, B);
const asC = actor('user-c', C);

function appointment(overrides: Partial<AppointmentRecord> = {}): AppointmentRecord {
  return {
    id: 'appt-1',
    patientId: 'patient-1',
    professionalId: B,
    locationId: CENTRO,
    appointmentTypeId: 'type-30',
    startsAt: new Date('2026-07-20T13:00:00.000Z'),
    endsAt: new Date('2026-07-20T13:30:00.000Z'),
    bufferMinutes: 0,
    lane: 1,
    status: 'scheduled',
    source: 'online',
    bookedBy: null,
    identityConfirmed: false,
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

function world(record = appointment(), overrides: Partial<FakeSchedulingState> = {}) {
  return createFakeSchedulingPorts({
    professionals: new Map([
      [B, { id: B, membershipId: 'mb', status: 'active', maxSimultaneous: 1, specialties: [] }],
      [C, { id: C, membershipId: 'mc', status: 'active', maxSimultaneous: 1, specialties: [] }],
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
    patients: new Map([
      ['patient-1', { id: 'patient-1', status: 'active' }],
      ['patient-2', { id: 'patient-2', status: 'active' }],
    ]),
    appointments: new Map([[record.id, record]]),
    weekly: [{ locationId: CENTRO, weekday: 1, startMinute: 540, endMinute: 780 }],
    ...overrides,
  });
}

const thrown = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('booking and the initial identity (D14)', () => {
  const book = (
    ports: ReturnType<typeof world>['ports'],
    who: BookActor,
    patientId = 'patient-1',
    professionalId = B,
  ) =>
    bookAppointment(ports, {
      request: {
        patientId,
        professionalId,
        locationId: CENTRO,
        appointmentTypeId: 'type-30',
        local: { date: '2026-07-20', time: '10:00' },
      },
      actor: who,
      auditActor: auditActor(who.userId),
      now: NOW,
    });

  it('starts unconfirmed and opens an identity review when a professional books themselves for an existing patient', async () => {
    const { ports, state } = world();

    const booked = await book(ports, asB);

    expect(booked.identityConfirmed).toBe(false);
    expect(state.openedItems).toEqual([
      {
        kind: 'identity_review',
        subjectType: 'appointment',
        subjectId: booked.id,
        locationId: CENTRO,
      },
    ]);
    expect(state.audits[0]?.metadata).toMatchObject({ identityConfirmed: false });
  });

  it('starts confirmed, with no review, when reception books the same patient', async () => {
    const { ports, state } = world();

    const booked = await book(ports, reception);

    expect(booked.identityConfirmed).toBe(true);
    expect(state.openedItems).toEqual([]);
  });

  it('starts confirmed when another professional books it for B', async () => {
    const { ports, state } = world();

    expect((await book(ports, asC, 'patient-1', B)).identityConfirmed).toBe(true);
    expect(state.openedItems).toEqual([]);
  });

  it('starts confirmed when the professional booked a patient they just registered', async () => {
    const { ports, state } = world(appointment(), { freshPatients: new Set(['patient-2']) });

    const booked = await book(ports, asB, 'patient-2');

    expect(booked.identityConfirmed).toBe(true);
    expect(state.openedItems).toEqual([]);
  });
});

describe('check-in with identity confirmation', () => {
  const checkIn = (
    ports: ReturnType<typeof world>['ports'],
    who: BookActor,
    confirmIdentity?: boolean,
  ) =>
    transitionAppointment(ports, {
      appointmentId: 'appt-1',
      action: 'check_in',
      actor: who,
      auditActor: auditActor(who.userId),
      now: NOW,
      ...(confirmIdentity === undefined ? {} : { confirmIdentity }),
    });

  it('lets reception confirm at check-in: confirmed as staff, the review closes, the audit names the actor', async () => {
    const { ports, state } = world();

    const result = await checkIn(ports, reception, true);

    expect(result).toMatchObject({
      status: 'checked_in',
      identityConfirmed: true,
      identityConfirmation: 'staff',
    });
    expect(state.updates[0]?.patch).toMatchObject({
      identityConfirmed: true,
      identityConfirmedBy: USER_RECEPTION,
      identityConfirmation: 'staff',
    });
    expect(state.closedItems).toEqual([
      {
        kind: 'identity_review',
        subjectId: 'appt-1',
        status: 'resolved',
        resolution: 'identity_confirmed',
      },
    ]);
    expect(state.events.map((event) => event.kind)).toEqual([
      'status_changed',
      'identity_confirmed',
    ]);
    expect(state.audits.map((audit) => audit.action)).toEqual([
      'appointment.status_changed',
      'appointment.identity.confirmed',
    ]);
    expect(state.audits[1]?.actor.userId).toBe(USER_RECEPTION);
  });

  it('checks in without confirming when the staff member does not confirm', async () => {
    const { ports, state } = world();

    const result = await checkIn(ports, reception);

    expect(result).toMatchObject({ status: 'checked_in', identityConfirmed: false });
    expect(state.closedItems).toEqual([]);
  });

  it('lets another professional confirm, as staff', async () => {
    const { ports } = world();

    expect((await checkIn(ports, asC, true)).identityConfirmation).toBe('staff');
  });

  it('does not let the own professional confirm when there is other staff: the status changes, the identity does not', async () => {
    const { ports, state } = world(appointment(), { solo: false });

    const result = await checkIn(ports, asB, true);

    expect(result).toMatchObject({ status: 'checked_in', identityConfirmed: false });
    expect(state.closedItems).toEqual([]);
    expect(state.audits.map((audit) => audit.action)).toEqual(['appointment.status_changed']);
  });

  it('lets the sole professional self-confirm at in-person check-in, with its own marker (D18)', async () => {
    const { ports, state } = world(appointment(), { solo: true });

    const result = await checkIn(ports, asB, true);

    expect(result).toMatchObject({
      identityConfirmed: true,
      identityConfirmation: 'self_confirmed',
    });
    expect(state.closedItems[0]).toMatchObject({ resolution: 'identity_self_confirmed' });
    expect(state.audits.map((audit) => audit.action)).toEqual([
      'appointment.status_changed',
      'appointment.identity.self_confirmed',
    ]);
  });

  it('ignores the confirmation of an appointment that is already confirmed', async () => {
    const { ports, state } = world(appointment({ identityConfirmed: true }));

    await checkIn(ports, reception, true);

    expect(state.events.map((event) => event.kind)).toEqual(['status_changed']);
    expect(state.closedItems).toEqual([]);
  });
});

describe('confirming from the worklist', () => {
  const confirm = (ports: ReturnType<typeof world>['ports'], who: BookActor) =>
    confirmIdentity(ports, {
      appointmentId: 'appt-1',
      actor: who,
      auditActor: auditActor(who.userId),
    });

  it('lets reception confirm the identity and closes the review', async () => {
    const { ports, state } = world();

    const result = await confirm(ports, reception);

    expect(result).toMatchObject({ identityConfirmed: true, identityConfirmation: 'staff' });
    expect(state.closedItems[0]).toMatchObject({
      kind: 'identity_review',
      resolution: 'identity_confirmed',
    });
    expect(state.audits[0]).toMatchObject({ action: 'appointment.identity.confirmed' });
  });

  it('refuses the professional of the appointment, even alone in the organization', async () => {
    for (const solo of [false, true]) {
      const { ports, state } = world(appointment(), { solo });

      const error = await thrown(confirm(ports, asB));

      expect(error).toBeInstanceOf(AccessRefused);
      expect(state.updates).toEqual([]);
      expect(state.closedItems).toEqual([]);
    }
  });

  it('refuses an appointment whose identity is already confirmed', async () => {
    const { ports } = world(appointment({ identityConfirmed: true }));

    expect(((await thrown(confirm(ports, reception))) as AppError).code).toBe('conflict');
  });
});

describe('rejecting the match (detach)', () => {
  const detach = (
    ports: ReturnType<typeof world>['ports'],
    who: BookActor,
    resolution: Parameters<typeof detachPatient>[1]['resolution'],
  ) =>
    detachPatient(ports, {
      appointmentId: 'appt-1',
      actor: who,
      auditActor: auditActor(who.userId),
      now: NOW,
      resolution,
    });

  it('moves the appointment to another patient record and confirms it there', async () => {
    const { ports, state } = world();

    const result = await detach(ports, reception, {
      kind: 'move_to_patient',
      patientId: 'patient-2',
    });

    expect(result).toMatchObject({ patientId: 'patient-2', identityConfirmed: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.patch).toMatchObject({
      patientId: 'patient-2',
      identityConfirmed: true,
      identityConfirmation: 'staff',
    });
    expect(state.closedItems[0]).toMatchObject({
      kind: 'identity_review',
      resolution: 'identity_rejected',
    });
    expect(state.events.map((event) => event.kind)).toEqual(['identity_rejected']);
    expect(state.audits[0]).toMatchObject({
      action: 'appointment.identity.rejected',
      metadata: { resolution: 'moved' },
    });
  });

  it('cancels the appointment instead', async () => {
    const { ports, state } = world();

    const result = await detach(ports, reception, {
      kind: 'cancel',
      cancellation: { cancelledBy: 'organization', reasonCode: 'other' },
    });

    expect(result.status).toBe('cancelled');
    expect(state.closedItems[0]).toMatchObject({ resolution: 'identity_rejected' });
    expect(state.audits.map((audit) => audit.action)).toEqual([
      'appointment.cancelled',
      'appointment.identity.rejected',
    ]);
  });

  it('refuses the appointment professional, and an unknown, inactive or same patient', async () => {
    const own = world();
    const unknown = world();
    const same = world();
    const inactive = world();
    inactive.state.patients.set('patient-3', { id: 'patient-3', status: 'inactive' });

    expect(
      await thrown(detach(own.ports, asB, { kind: 'move_to_patient', patientId: 'patient-2' })),
    ).toBeInstanceOf(AccessRefused);
    expect(
      (
        (await thrown(
          detach(unknown.ports, reception, { kind: 'move_to_patient', patientId: 'nobody' }),
        )) as AppError
      ).code,
    ).toBe('not_found');
    expect(
      (
        (await thrown(
          detach(same.ports, reception, { kind: 'move_to_patient', patientId: 'patient-1' }),
        )) as AppError
      ).code,
    ).toBe('validation_failed');
    expect(
      (
        (await thrown(
          detach(inactive.ports, reception, { kind: 'move_to_patient', patientId: 'patient-3' }),
        )) as AppError
      ).code,
    ).toBe('conflict');
  });

  it('has nothing to reject on an appointment whose identity is confirmed', async () => {
    const { ports } = world(appointment({ identityConfirmed: true }));

    const error = await thrown(
      detach(ports, reception, { kind: 'move_to_patient', patientId: 'patient-2' }),
    );

    expect((error as AppError).code).toBe('conflict');
  });
});
