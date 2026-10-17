import type { BookAppointmentRequest, HolidayDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../platform/http/problem.js';
import {
  createFakeSchedulingPorts,
  type FakeSchedulingState,
} from '../../../testing/scheduling-ports.js';
import { AccessRefused } from '../../access/index.js';

import { bookAppointment, SlotTakenError, type BookActor } from './book-appointment.js';

const BA = 'America/Argentina/Buenos_Aires';
const DOCTOR = 'doctor-1';
const CENTRO = 'centro';
const NORTE = 'norte';
const TYPE = 'type-30';
const PATIENT = 'patient-1';
const USER = 'user-reception';
const NOW = new Date('2026-07-06T12:00:00.000Z');
const utc = (text: string) => Date.parse(text);

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture is missing');
  return value;
}

const auditActor = {
  userId: USER,
  actingRole: 'reception' as const,
  ip: null,
  userAgent: null,
  requestId: null,
};

function actor(permissions: string[] = []): BookActor {
  return {
    userId: USER,
    permissions: new Set(['scheduling.book', ...permissions]),
    professionalId: null,
  };
}

function world(
  overrides: Partial<FakeSchedulingState> = {},
  options: { capacity?: number; buffer?: number } = {},
) {
  return createFakeSchedulingPorts({
    professionals: new Map([
      [
        DOCTOR,
        {
          id: DOCTOR,
          membershipId: 'm1',
          status: 'active',
          maxSimultaneous: options.capacity ?? 1,
          specialties: ['general'],
        },
      ],
    ]),
    locations: new Map([
      [CENTRO, { id: CENTRO, timeZone: BA, active: true }],
      [NORTE, { id: NORTE, timeZone: BA, active: true }],
    ]),
    types: new Map([
      [
        TYPE,
        {
          id: TYPE,
          durationMinutes: 30,
          bufferMinutes: options.buffer ?? 0,
          active: true,
          requiresApproval: false,
          professionalIds: [],
          specialties: [],
        },
      ],
    ]),
    patients: new Map([[PATIENT, { id: PATIENT, status: 'active' }]]),
    // Monday and Tuesday 09:00-13:00 at Centro (minutes of the local day).
    weekly: [
      { locationId: CENTRO, weekday: 1, startMinute: 540, endMinute: 780 },
      { locationId: CENTRO, weekday: 2, startMinute: 540, endMinute: 780 },
    ],
    ...overrides,
  });
}

/** Monday 2026-07-13 at the given local time, as a request. */
const book = (
  time: string,
  extra: Partial<BookAppointmentRequest> = {},
): BookAppointmentRequest => ({
  patientId: PATIENT,
  professionalId: DOCTOR,
  locationId: CENTRO,
  appointmentTypeId: TYPE,
  local: { date: '2026-07-13', time },
  ...extra,
});

const run = (
  ports: ReturnType<typeof world>['ports'],
  request: BookAppointmentRequest,
  who: BookActor = actor(),
  now = NOW,
) => bookAppointment(ports, { request, actor: who, auditActor, now });

const message = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('a plain booking', () => {
  it('books the slot, derives the end from the type and records who and when', async () => {
    const { ports, state } = world();

    const appointment = await run(ports, book('10:00'));

    expect(appointment).toMatchObject({
      status: 'scheduled',
      source: 'staff',
      startsAt: '2026-07-13T13:00:00.000Z',
      endsAt: '2026-07-13T13:30:00.000Z',
      bookedBy: USER,
      outOfHours: false,
      identityConfirmed: true,
    });
    expect(state.inserted[0]).toMatchObject({ lane: 1, bufferMinutes: 0 });
    expect(state.locked).toEqual([DOCTOR]);
    expect(state.expired).toEqual([{ professionalId: DOCTOR, now: NOW }]);
  });

  it('accepts an instant as well as a local time', async () => {
    const { ports } = world();

    const appointment = await run(ports, {
      ...book('10:00'),
      local: undefined,
      startsAt: '2026-07-13T10:00:00-03:00',
    });

    expect(appointment.startsAt).toBe('2026-07-13T13:00:00.000Z');
  });

  it('writes the creation to the history and to the audit trail', async () => {
    const { ports, state } = world();

    const appointment = await run(ports, book('10:00'));

    expect(state.events).toEqual([
      expect.objectContaining({
        appointmentId: appointment.id,
        kind: 'created',
        toStatus: 'scheduled',
        actorUserId: USER,
        actorKind: 'staff',
      }),
    ]);
    expect(state.audits.map((audit) => audit.action)).toEqual(['appointment.created']);
    expect(state.audits[0]).toMatchObject({
      outcome: 'allow',
      resourceType: 'appointment',
      resourceId: appointment.id,
      patientId: PATIENT,
    });
  });

  it('copies the buffer of the type onto the appointment', async () => {
    const { ports, state } = world({}, { buffer: 10 });

    await run(ports, book('10:00'));

    expect(state.inserted[0]?.bufferMinutes).toBe(10);
  });
});

describe('what must exist and belong to the organization', () => {
  it.each([
    ['patient', { patientId: 'nobody' }],
    ['professional', { professionalId: 'nobody' }],
    ['location', { locationId: 'nobody' }],
    ['type', { appointmentTypeId: 'nobody' }],
  ])(
    'answers not found for an unknown %s (another organization looks the same)',
    async (_name, patch) => {
      const { ports, state } = world();

      const error = await message(run(ports, book('10:00', patch)));

      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('not_found');
      expect(state.inserted).toEqual([]);
    },
  );

  it('refuses a deactivated type, professional, location or patient', async () => {
    for (const patch of [
      (s: FakeSchedulingState) => (must(s.types.get(TYPE)).active = false),
      (s: FakeSchedulingState) => (must(s.professionals.get(DOCTOR)).status = 'inactive'),
      (s: FakeSchedulingState) => (must(s.locations.get(CENTRO)).active = false),
      (s: FakeSchedulingState) => (must(s.patients.get(PATIENT)).status = 'inactive'),
    ]) {
      const { ports, state } = world();
      patch(state);

      const error = await message(run(ports, book('10:00')));

      expect((error as AppError).code).toBe('conflict');
      expect(state.inserted).toEqual([]);
    }
  });

  it('respects the restriction of a type to some professionals or specialties', async () => {
    const byProfessional = world();
    must(byProfessional.state.types.get(TYPE)).professionalIds = ['someone-else'];
    const bySpecialty = world();
    must(bySpecialty.state.types.get(TYPE)).specialties = ['cardiology'];
    const allowed = world();
    must(allowed.state.types.get(TYPE)).specialties = ['general', 'cardiology'];

    for (const { ports } of [byProfessional, bySpecialty]) {
      const error = await message(run(ports, book('10:00')));
      expect((error as AppError).code).toBe('validation_failed');
      expect((error as AppError).fieldErrors[0]?.i18nKey).toBe(
        'scheduling.booking.type_not_offered',
      );
    }
    expect((await run(allowed.ports, book('10:00'))).status).toBe('scheduled');
  });
});

describe('the past', () => {
  it('rejects yesterday for a user without the permission, with a message about the time', async () => {
    const { ports, state } = world();

    const error = await message(
      run(ports, book('10:00'), actor(), new Date('2026-07-14T12:00:00.000Z')),
    );

    expect((error as AppError).code).toBe('validation_failed');
    expect((error as AppError).fieldErrors).toEqual([
      { path: 'startsAt', i18nKey: 'scheduling.booking.in_past' },
    ]);
    expect(state.inserted).toEqual([]);
  });

  it('accepts it with the permission and audits it as an override', async () => {
    const { ports, state } = world();

    await run(
      ports,
      book('10:00'),
      actor(['scheduling.register_past']),
      new Date('2026-07-14T12:00:00.000Z'),
    );

    expect(state.audits.map((audit) => audit.action)).toEqual([
      'appointment.created',
      'appointment.overridden',
    ]);
    expect(state.audits[1]?.metadata).toMatchObject({ kinds: ['past'] });
  });
});

describe('working hours, blocks and holidays', () => {
  it('rejects a time outside the working hours of the location', async () => {
    const { ports } = world();

    const error = await message(run(ports, book('15:00')));

    expect((error as AppError).fieldErrors[0]).toEqual({
      path: 'startsAt',
      i18nKey: 'scheduling.booking.outside_working_hours',
    });
  });

  it('rejects an appointment that starts inside the hours but ends after them', async () => {
    const { ports } = world();

    const error = await message(run(ports, book('12:45')));

    expect((error as AppError).fieldErrors[0]?.i18nKey).toBe(
      'scheduling.booking.outside_working_hours',
    );
  });

  it('rejects a day on which the professional does not work at that location', async () => {
    const { ports } = world();

    const error = await message(run(ports, book('10:00', { locationId: NORTE })));

    expect((error as AppError).fieldErrors[0]?.i18nKey).toBe(
      'scheduling.booking.outside_working_hours',
    );
  });

  it('lets an authorized user override with a reason, flags it and audits reason and actor', async () => {
    const { ports, state } = world();

    const appointment = await run(
      ports,
      book('15:00', { overrideHours: { reason: 'Urgent follow-up' } }),
      actor(['scheduling.override_hours']),
    );

    expect(appointment.outOfHours).toBe(true);
    expect(state.inserted[0]).toMatchObject({
      outOfHours: true,
      overrideReason: 'Urgent follow-up',
    });
    expect(state.audits.map((audit) => audit.action)).toEqual([
      'appointment.created',
      'appointment.overridden',
    ]);
    expect(state.audits[1]).toMatchObject({
      actor: { userId: USER },
      metadata: { kinds: ['out_of_hours'], overrideReason: 'Urgent follow-up' },
    });
  });

  it('refuses an override from a user who does not hold the permission', async () => {
    const { ports, state } = world();

    const error = await message(
      run(ports, book('15:00', { overrideHours: { reason: 'Trying' } }), actor()),
    );

    expect(error).toBeInstanceOf(AccessRefused);
    expect(state.inserted).toEqual([]);
  });

  it('does not flag an override the booking did not need', async () => {
    const { ports, state } = world();

    const appointment = await run(
      ports,
      book('10:00', { overrideHours: { reason: 'Not needed' } }),
      actor(['scheduling.override_hours']),
    );

    expect(appointment.outOfHours).toBe(false);
    expect(state.audits.map((audit) => audit.action)).toEqual(['appointment.created']);
  });

  it('rejects a block citing it, and lets an override book over it', async () => {
    const { ports } = world({
      blocks: [{ start: utc('2026-07-13T13:00:00Z'), end: utc('2026-07-13T15:00:00Z') }],
    });

    const error = await message(run(ports, book('10:00')));
    const forced = await run(
      ports,
      book('10:00', { overrideHours: { reason: 'Doctor is in' } }),
      actor(['scheduling.override_hours']),
    );

    expect((error as AppError).fieldErrors[0]?.i18nKey).toBe('scheduling.booking.blocked');
    expect(forced.outOfHours).toBe(true);
  });

  it('rejects a holiday', async () => {
    const holiday: HolidayDto = {
      day: '2026-07-13',
      name: 'Feriado',
      source: 'national',
      locationId: null,
      dayOffId: null,
    };
    const { ports } = world({ holidays: [holiday] });

    const error = await message(run(ports, book('10:00')));

    expect((error as AppError).fieldErrors[0]?.i18nKey).toBe('scheduling.booking.holiday');
  });

  it('applies the hours for a range of dates in place of the weekly hours', async () => {
    const { ports } = world({
      periods: [
        {
          dateFrom: '2026-07-13',
          dateTo: '2026-07-19',
          rows: [{ locationId: CENTRO, weekday: 1, startMinute: 840, endMinute: 1020 }],
        },
      ],
    });

    expect((await message(run(ports, book('10:00')))) as AppError).toBeInstanceOf(AppError);
    expect((await run(ports, book('15:00'))).status).toBe('scheduled');
  });
});

describe('local time and daylight saving', () => {
  const madrid = () =>
    createFakeSchedulingPorts({
      professionals: new Map([
        [
          DOCTOR,
          { id: DOCTOR, membershipId: 'm', status: 'active', maxSimultaneous: 1, specialties: [] },
        ],
      ]),
      locations: new Map([[CENTRO, { id: CENTRO, timeZone: 'Europe/Madrid', active: true }]]),
      types: new Map([
        [
          TYPE,
          {
            id: TYPE,
            durationMinutes: 30,
            bufferMinutes: 0,
            active: true,
            requiresApproval: false,
            professionalIds: [],
            specialties: [],
          },
        ],
      ]),
      patients: new Map([[PATIENT, { id: PATIENT, status: 'active' }]]),
      // Every day of the week, around the clock, so only the clock rules matter here.
      weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        locationId: CENTRO,
        weekday,
        startMinute: 0,
        endMinute: 1440,
      })),
    });

  it('rejects a local time that does not exist', async () => {
    const { ports } = madrid();

    const error = await message(
      run(
        ports,
        { ...book('02:30'), local: { date: '2026-03-29', time: '02:30' } },
        actor(['scheduling.register_past']),
        new Date('2026-03-01T00:00:00Z'),
      ),
    );

    expect((error as AppError).fieldErrors).toEqual([
      { path: 'local.time', i18nKey: 'scheduling.booking.local_time_nonexistent' },
    ]);
  });

  it('asks which occurrence is meant for a time that happens twice, and stores the chosen instant', async () => {
    const { ports } = madrid();
    const request = { ...book('02:30'), local: { date: '2026-10-25', time: '02:30' } };
    const early = new Date('2026-10-01T00:00:00Z');

    const asked = await message(run(ports, request, actor(), early));
    const second = await run(
      ports,
      { ...request, local: { ...request.local, occurrence: 'second' as const } },
      actor(),
      early,
    );

    expect((asked as AppError).fieldErrors).toEqual([
      { path: 'local.occurrence', i18nKey: 'scheduling.booking.local_time_ambiguous' },
    ]);
    expect(second.startsAt).toBe('2026-10-25T01:30:00.000Z');
  });

  it('measures the length in elapsed time across a clock change', async () => {
    const { ports } = madrid();
    ports.findType = () =>
      Promise.resolve({
        id: TYPE,
        durationMinutes: 120,
        bufferMinutes: 0,
        active: true,
        requiresApproval: false,
        professionalIds: [],
        specialties: [],
      });

    const appointment = await run(
      ports,
      { ...book('01:00'), local: { date: '2026-03-29', time: '01:00' } },
      actor(),
      new Date('2026-03-01T00:00:00Z'),
    );

    // 01:00 local is 00:00Z; two elapsed hours later is 02:00Z, which reads 04:00 on the wall.
    expect(appointment.endsAt).toBe('2026-03-29T02:00:00.000Z');
  });
});

describe('conflicts', () => {
  const taken = (from: string, to: string, extra: Record<string, unknown> = {}) => ({
    id: `occ-${from}`,
    kind: 'appointment' as const,
    locationId: CENTRO,
    lane: 1,
    start: utc(from),
    end: utc(to),
    ...extra,
  });

  it('rejects an overlap with the conflicting range and the next free slots, without clinical data', async () => {
    const { ports, state } = world({
      occupancies: [taken('2026-07-13T13:00:00Z', '2026-07-13T13:30:00Z')],
    });

    const error = await message(run(ports, book('10:15')));

    expect(error).toBeInstanceOf(SlotTakenError);
    const conflict = error as SlotTakenError;
    expect(conflict.conflict).toEqual({
      start: utc('2026-07-13T13:00:00Z'),
      end: utc('2026-07-13T13:30:00Z'),
    });
    const next = conflict.nextSlots.map((slot) => new Date(slot.start).toISOString());
    expect(next.slice(0, 3)).toEqual([
      '2026-07-13T13:30:00.000Z',
      '2026-07-13T13:45:00.000Z',
      '2026-07-13T14:00:00.000Z',
    ]);
    expect(next).not.toContain('2026-07-13T13:00:00.000Z');
    expect(state.inserted).toEqual([]);
  });

  it('allows back to back and rejects a start inside the buffer of the previous one', async () => {
    const free = world({ occupancies: [taken('2026-07-13T13:00:00Z', '2026-07-13T13:30:00Z')] });
    const buffered = world({
      occupancies: [taken('2026-07-13T13:00:00Z', '2026-07-13T13:40:00Z')],
    });

    expect((await run(free.ports, book('10:30'))).startsAt).toBe('2026-07-13T13:30:00.000Z');
    expect(await message(run(buffered.ports, book('10:30')))).toBeInstanceOf(SlotTakenError);
    expect((await run(buffered.ports, book('10:40'))).startsAt).toBe('2026-07-13T13:40:00.000Z');
  });

  it('rejects an appointment whose own buffer runs into a later one', async () => {
    const { ports } = world(
      { occupancies: [taken('2026-07-13T14:00:00Z', '2026-07-13T14:30:00Z')] },
      { buffer: 10 },
    );

    expect(await message(run(ports, book('10:30')))).toBeInstanceOf(SlotTakenError);
    expect((await run(ports, book('10:20'))).startsAt).toBe('2026-07-13T13:20:00.000Z');
  });

  it('never double-books a professional at another location, whatever the capacity', async () => {
    const { ports } = world(
      {
        occupancies: [taken('2026-07-13T13:00:00Z', '2026-07-13T13:30:00Z', { locationId: NORTE })],
      },
      { capacity: 3 },
    );

    expect(await message(run(ports, book('10:00')))).toBeInstanceOf(SlotTakenError);
  });

  it('uses the next lane when overbooking is on, up to the capacity', async () => {
    const { ports, state } = world(
      { occupancies: [taken('2026-07-13T13:00:00Z', '2026-07-13T13:30:00Z')] },
      { capacity: 2 },
    );

    const second = await run(ports, book('10:00'));
    const third = await message(run(ports, book('10:00')));

    expect(state.inserted[0]?.lane).toBe(2);
    expect(second.status).toBe('scheduled');
    expect(third).toBeInstanceOf(SlotTakenError);
  });

  it('moves another appointment to a different lane to make room when capacity allows', async () => {
    const { ports, state } = world(
      {
        occupancies: [
          { ...taken('2026-07-13T13:00:00Z', '2026-07-13T13:30:00Z'), id: 'x', lane: 1 },
          { ...taken('2026-07-13T13:30:00Z', '2026-07-13T14:00:00Z'), id: 'y', lane: 2 },
        ],
      },
      { capacity: 2 },
    );

    const appointment = await run(ports, book('10:15'));

    expect(appointment.startsAt).toBe('2026-07-13T13:15:00.000Z');
    expect(state.laneMoves).toEqual([{ kind: 'appointment', id: 'y', lane: 1 }]);
    expect(state.inserted[0]?.lane).toBe(2);
  });

  describe('re-laning along a chain of occupancies', () => {
    // Capacity 2. Lane 1 holds B 10:00-10:40 and E 11:15-12:00, lane 2 holds C 10:40-11:30. The new
    // 10:30-11:00 booking touches B and C only; E is connected to it through C (depth 2).
    const chain = () => [
      { ...taken('2026-07-13T13:00:00Z', '2026-07-13T13:40:00Z'), id: 'B', lane: 1 },
      { ...taken('2026-07-13T13:40:00Z', '2026-07-13T14:30:00Z'), id: 'C', lane: 2 },
      { ...taken('2026-07-13T14:15:00Z', '2026-07-13T15:00:00Z'), id: 'E', lane: 1 },
    ];

    it('moves every occupancy of the chain, not only the ones that touch the new range', async () => {
      const { ports, state } = world({ occupancies: chain() }, { capacity: 2 });

      const appointment = await run(ports, book('10:30'));

      expect(appointment.startsAt).toBe('2026-07-13T13:30:00.000Z');
      expect(state.laneMoves).toEqual([
        { kind: 'appointment', id: 'C', lane: 1 },
        { kind: 'appointment', id: 'E', lane: 2 },
      ]);
      expect(state.inserted[0]?.lane).toBe(2);
    });

    it('follows a chain of depth 3 and leaves no two overlapping occupancies in one lane', async () => {
      const { ports, state } = world(
        {
          occupancies: [
            ...chain(),
            // G is connected through E only: it overlaps E, not C and not the new booking.
            { ...taken('2026-07-13T14:50:00Z', '2026-07-13T15:40:00Z'), id: 'G', lane: 2 },
          ],
        },
        { capacity: 2 },
      );

      await run(ports, book('10:30'));

      expect(state.laneMoves).toEqual([
        { kind: 'appointment', id: 'C', lane: 1 },
        { kind: 'appointment', id: 'E', lane: 2 },
        { kind: 'appointment', id: 'G', lane: 1 },
      ]);
      expect(state.occupancies).toHaveLength(5);
      for (const a of state.occupancies) {
        for (const b of state.occupancies) {
          if (a.id < b.id && a.start < b.end && b.start < a.end) {
            expect(a.lane).not.toBe(b.lane);
          }
        }
      }
    });

    it('still refuses with the conflict when both lanes are taken inside the new range', async () => {
      const { ports, state } = world(
        {
          occupancies: [
            { ...taken('2026-07-13T13:00:00Z', '2026-07-13T13:40:00Z'), id: 'B', lane: 1 },
            { ...taken('2026-07-13T13:30:00Z', '2026-07-13T14:30:00Z'), id: 'C', lane: 2 },
            { ...taken('2026-07-13T14:30:00Z', '2026-07-13T15:00:00Z'), id: 'E', lane: 2 },
          ],
        },
        { capacity: 2 },
      );

      const error = await message(run(ports, book('10:30')));

      expect(error).toBeInstanceOf(SlotTakenError);
      expect(state.laneMoves).toEqual([]);
    });

    it('moves nothing when a lane is free for the new range', async () => {
      const { ports, state } = world({ occupancies: chain() }, { capacity: 2 });

      // 10:00 local touches B only: lane 2 is free there.
      const appointment = await run(ports, book('10:00'));

      expect(appointment.startsAt).toBe('2026-07-13T13:00:00.000Z');
      expect(state.laneMoves).toEqual([]);
      expect(state.inserted[0]?.lane).toBe(2);
    });
  });

  it('turns an overlap the database caught (a race that slipped through) into the same conflict', async () => {
    const { ports, state } = world();
    state.failNextInsert = true;

    const error = await message(run(ports, book('10:00')));

    expect(error).toBeInstanceOf(SlotTakenError);
    expect((error as SlotTakenError).nextSlots.length).toBeGreaterThan(0);
  });
});

describe('an overlap the database refuses after the checks (a race that slipped through)', () => {
  it('answers a lane move that collides with the same conflict, with the next free slots', async () => {
    const { ports, state } = world(
      {
        occupancies: [
          {
            id: 'x',
            kind: 'appointment' as const,
            locationId: CENTRO,
            lane: 1,
            start: utc('2026-07-13T13:00:00Z'),
            end: utc('2026-07-13T13:30:00Z'),
          },
          {
            id: 'y',
            kind: 'appointment' as const,
            locationId: CENTRO,
            lane: 2,
            start: utc('2026-07-13T13:30:00Z'),
            end: utc('2026-07-13T14:00:00Z'),
          },
        ],
      },
      { capacity: 2 },
    );
    state.refuseOverlapOn.add('applyLaneMoves');

    const error = await message(run(ports, book('10:15')));

    expect(error).toBeInstanceOf(SlotTakenError);
    expect((error as SlotTakenError).nextSlots.length).toBeGreaterThan(0);
    expect(state.inserted).toEqual([]);
  });
});

describe('holds', () => {
  const hold = {
    id: 'hold-1',
    kind: 'hold' as const,
    locationId: CENTRO,
    lane: 1,
    start: utc('2026-07-13T13:00:00Z'),
    end: utc('2026-07-13T13:30:00Z'),
    holdOrigin: 'public' as const,
  };

  it('counts an active hold toward capacity: booking over it without an override is a conflict', async () => {
    const { ports } = world({ occupancies: [hold] });

    expect(await message(run(ports, book('10:00')))).toBeInstanceOf(SlotTakenError);
  });

  it('books over a hold with the explicit override and invalidates it', async () => {
    const { ports, state } = world({ occupancies: [hold] });

    const appointment = await run(
      ports,
      book('10:00', { overrideHold: true }),
      actor(['scheduling.override_hold']),
    );

    expect(appointment.status).toBe('scheduled');
    expect(state.invalidatedHolds).toEqual(['hold-1']);
    expect(state.audits.map((audit) => audit.action)).toEqual([
      'appointment.created',
      'appointment.overridden',
    ]);
    expect(state.audits[1]?.metadata).toMatchObject({ kinds: ['hold'] });
  });

  it('refuses the override to a user without the permission, and leaves the hold alone', async () => {
    const { ports, state } = world({ occupancies: [hold] });

    const error = await message(run(ports, book('10:00', { overrideHold: true })));

    expect(error).toBeInstanceOf(AccessRefused);
    expect((error as AccessRefused).reason).toBe('override_hold_not_permitted');
    expect(state.invalidatedHolds).toEqual([]);
    expect(state.inserted).toEqual([]);
  });

  it('does not invalidate a hold that is not in the way', async () => {
    const { ports, state } = world({
      occupancies: [
        { ...hold, start: utc('2026-07-13T15:00:00Z'), end: utc('2026-07-13T15:30:00Z') },
      ],
    });

    // Nothing is overridden, so the permission is not asked for.
    await run(ports, book('10:00', { overrideHold: true }));

    expect(state.invalidatedHolds).toEqual([]);
    expect(state.audits.map((audit) => audit.action)).toEqual(['appointment.created']);
  });

  it('does not let the override take an appointment out of the way', async () => {
    const appointmentInTheWay = { ...hold, id: 'appt-1', kind: 'appointment' as const };
    const { ports } = world({ occupancies: [appointmentInTheWay] });

    expect(
      await message(
        run(ports, book('10:00', { overrideHold: true }), actor(['scheduling.override_hold'])),
      ),
    ).toBeInstanceOf(SlotTakenError);
  });
});
