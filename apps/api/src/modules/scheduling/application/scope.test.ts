import { describe, expect, it } from 'vitest';

import { createFakeSchedulingPorts } from '../../../testing/scheduling-ports.js';
import { AccessRefused } from '../../access/index.js';

import { bookAppointment } from './book-appointment.js';
import { createHold } from './holds.js';
import { rescheduleAppointment, transitionAppointment } from './lifecycle.js';
import type { BookActor } from './placement.js';
import type { AppointmentRecord } from './ports.js';
import { bookSeries } from './series.js';

const BA = 'America/Argentina/Buenos_Aires';
const ME = 'professional-me';
const COLLEAGUE = 'professional-colleague';
const CENTRO = 'centro';
const NORTE = 'norte';
const NOW = new Date('2026-07-06T12:00:00.000Z');

const auditActor = {
  userId: 'user',
  actingRole: 'professional' as const,
  ip: null,
  userAgent: null,
  requestId: null,
};

/** A professional who works only in their own calendar, at Centro only. */
const scoped = (extra: Partial<BookActor> = {}): BookActor => ({
  userId: 'user',
  permissions: new Set(['scheduling.book', 'scheduling.checkin']),
  professionalId: ME,
  mayUseCalendar: (id) => id === ME,
  mayUseLocation: (id) => id === CENTRO,
  ...extra,
});

function record(overrides: Partial<AppointmentRecord> = {}): AppointmentRecord {
  return {
    id: 'appt-1',
    patientId: 'patient-1',
    professionalId: COLLEAGUE,
    locationId: CENTRO,
    appointmentTypeId: 'type-30',
    startsAt: new Date('2026-07-20T13:00:00.000Z'),
    endsAt: new Date('2026-07-20T13:30:00.000Z'),
    bufferMinutes: 0,
    lane: 1,
    status: 'scheduled',
    source: 'staff',
    bookedBy: 'user',
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

function world(appointment = record()) {
  return createFakeSchedulingPorts({
    professionals: new Map([
      [ME, { id: ME, membershipId: 'm1', status: 'active', maxSimultaneous: 1, specialties: [] }],
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
    appointments: new Map([[appointment.id, appointment]]),
    weekly: [
      { locationId: CENTRO, weekday: 1, startMinute: 540, endMinute: 780 },
      { locationId: NORTE, weekday: 1, startMinute: 540, endMinute: 780 },
    ],
  });
}

const thrown = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const slot = { local: { date: '2026-07-13', time: '10:00' } };

describe('a professional works in their own calendar only', () => {
  it('books, holds and plans a series in their own calendar', async () => {
    const { ports } = world();
    const request = {
      patientId: 'patient-1',
      professionalId: ME,
      locationId: CENTRO,
      appointmentTypeId: 'type-30',
      ...slot,
    };

    expect(
      (await bookAppointment(ports, { request, actor: scoped(), auditActor, now: NOW }))
        .professionalId,
    ).toBe(ME);
    await createHold(ports, {
      request: { ...request, local: { date: '2026-07-13', time: '11:00' } },
      actor: scoped(),
      now: NOW,
      origin: 'staff',
      sourceKey: 'user',
    });
  });

  it('is refused for a colleague’s calendar, in booking, holding and series, before anything is written', async () => {
    const { ports, state } = world();
    const request = {
      patientId: 'patient-1',
      professionalId: COLLEAGUE,
      locationId: CENTRO,
      appointmentTypeId: 'type-30',
      ...slot,
    };

    const book = await thrown(
      bookAppointment(ports, { request, actor: scoped(), auditActor, now: NOW }),
    );
    const hold = await thrown(
      createHold(ports, { request, actor: scoped(), now: NOW, origin: 'staff', sourceKey: 'user' }),
    );
    const series = await thrown(
      bookSeries(ports, {
        request: {
          ...request,
          recurrence: { frequency: 'weekly', everyWeeks: 1, count: 2 },
          mode: 'commit',
          skip: [],
        },
        actor: scoped(),
        auditActor,
        now: NOW,
      }),
    );

    for (const error of [book, hold, series]) {
      expect(error).toBeInstanceOf(AccessRefused);
      expect((error as AccessRefused).reason).toBe('not_own_calendar');
    }
    expect(state.inserted).toEqual([]);
    expect(state.holds.size).toBe(0);
  });

  it('is refused for every change to an appointment of a colleague', async () => {
    const { ports, state } = world();
    const change = (action: Parameters<typeof transitionAppointment>[1]['action']) =>
      transitionAppointment(ports, {
        appointmentId: 'appt-1',
        action,
        actor: scoped(),
        auditActor,
        now: NOW,
        expectedVersion: 1,
        cancellation: { cancelledBy: 'patient', reasonCode: 'illness' },
      });

    for (const action of ['confirm', 'check_in', 'no_show', 'cancel'] as const) {
      const error = await thrown(change(action));
      expect(error, action).toBeInstanceOf(AccessRefused);
    }
    const moved = await thrown(
      rescheduleAppointment(ports, {
        appointmentId: 'appt-1',
        expectedVersion: 1,
        local: { date: '2026-07-27', time: '10:00' },
        actor: scoped(),
        auditActor,
        now: NOW,
      }),
    );
    expect(moved).toBeInstanceOf(AccessRefused);
    expect(state.updates).toEqual([]);
  });

  it('cannot take an appointment of their own into a colleague’s calendar by rescheduling', async () => {
    const { ports } = world(record({ professionalId: ME }));

    const error = await thrown(
      rescheduleAppointment(ports, {
        appointmentId: 'appt-1',
        expectedVersion: 1,
        professionalId: COLLEAGUE,
        actor: scoped(),
        auditActor,
        now: NOW,
      }),
    );

    expect(error).toBeInstanceOf(AccessRefused);
  });

  it('works in a delegated calendar', async () => {
    const { ports } = world();
    const delegated = scoped({ mayUseCalendar: (id) => id === ME || id === COLLEAGUE });

    const done = await transitionAppointment(ports, {
      appointmentId: 'appt-1',
      action: 'confirm',
      actor: delegated,
      auditActor,
      now: NOW,
      expectedVersion: 1,
    });

    expect(done.status).toBe('confirmed');
  });
});

describe('reception works at its locations only', () => {
  it('is refused for an appointment at another location', async () => {
    const { ports, state } = world(record({ locationId: NORTE }));
    const reception = scoped({ professionalId: null, mayUseCalendar: () => true });

    const error = await thrown(
      transitionAppointment(ports, {
        appointmentId: 'appt-1',
        action: 'check_in',
        actor: reception,
        auditActor,
        now: NOW,
        expectedVersion: 1,
      }),
    );

    expect(error).toBeInstanceOf(AccessRefused);
    expect((error as AccessRefused).reason).toBe('location_not_assigned');
    expect(state.updates).toEqual([]);
  });
});

describe('a reception user who is also a professional', () => {
  // Reception limits them to Centro for everybody's calendar; only their own is open everywhere.
  const both = (): BookActor =>
    scoped({
      mayUseCalendar: () => true,
      mayUseLocation: (locationId, professionalId) =>
        locationId === CENTRO || professionalId === ME,
    });
  const confirm = (ports: ReturnType<typeof world>['ports'], who: BookActor) =>
    transitionAppointment(ports, {
      appointmentId: 'appt-1',
      action: 'confirm',
      actor: who,
      auditActor,
      now: NOW,
      expectedVersion: 1,
    });

  it('is refused for a colleague’s appointment at a location they are not assigned to', async () => {
    const { ports, state } = world(record({ professionalId: COLLEAGUE, locationId: NORTE }));

    const error = await thrown(confirm(ports, both()));

    expect(error).toBeInstanceOf(AccessRefused);
    expect((error as AccessRefused).reason).toBe('location_not_assigned');
    expect(state.updates).toEqual([]);
  });

  it('works in their own calendar at any location', async () => {
    const { ports } = world(record({ professionalId: ME, locationId: NORTE }));

    expect((await confirm(ports, both())).status).toBe('confirmed');
  });

  it('works in a colleague’s calendar at an assigned location', async () => {
    const { ports } = world(record({ professionalId: COLLEAGUE, locationId: CENTRO }));

    expect((await confirm(ports, both())).status).toBe('confirmed');
  });

  it('is refused when a reschedule moves a colleague’s appointment to a location not assigned', async () => {
    const { ports, state } = world(record({ professionalId: COLLEAGUE, locationId: CENTRO }));

    const error = await thrown(
      rescheduleAppointment(ports, {
        appointmentId: 'appt-1',
        expectedVersion: 1,
        locationId: NORTE,
        actor: both(),
        auditActor,
        now: NOW,
      }),
    );

    expect(error).toBeInstanceOf(AccessRefused);
    expect((error as AccessRefused).reason).toBe('location_not_assigned');
    expect(state.updates).toEqual([]);
  });
});
