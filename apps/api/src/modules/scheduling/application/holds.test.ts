import { describe, expect, it } from 'vitest';

import { type AppError } from '../../../platform/http/problem.js';
import {
  createFakeSchedulingPorts,
  type FakeSchedulingState,
} from '../../../testing/scheduling-ports.js';

import { bookAppointment } from './book-appointment.js';
import { createHold, HOLD_MINUTES, releaseHold, SlotNoLongerAvailableError } from './holds.js';
import { SlotTakenError, type BookActor } from './placement.js';
import type { ActiveOccupancy, HoldRecord } from './ports.js';

const BA = 'America/Argentina/Buenos_Aires';
const DOCTOR = 'doctor-1';
const CENTRO = 'centro';
const USER = 'user-reception';
const NOW = new Date('2026-07-06T12:00:00.000Z');
const utc = (text: string) => Date.parse(text);

const auditActor = {
  userId: USER,
  actingRole: 'reception' as const,
  ip: null,
  userAgent: null,
  requestId: null,
};
const actor: BookActor = {
  userId: USER,
  permissions: new Set(['scheduling.book']),
  professionalId: null,
};

function world(overrides: Partial<FakeSchedulingState> = {}, capacity = 1) {
  return createFakeSchedulingPorts({
    professionals: new Map([
      [
        DOCTOR,
        {
          id: DOCTOR,
          membershipId: 'm',
          status: 'active',
          maxSimultaneous: capacity,
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
    weekly: [{ locationId: CENTRO, weekday: 1, startMinute: 540, endMinute: 780 }],
    ...overrides,
  });
}

const hold = (overrides: Partial<HoldRecord> = {}): HoldRecord => ({
  id: 'hold-1',
  professionalId: DOCTOR,
  locationId: CENTRO,
  startsAt: new Date('2026-07-13T13:00:00.000Z'),
  endsAt: new Date('2026-07-13T13:30:00.000Z'),
  bufferMinutes: 0,
  lane: 1,
  status: 'active',
  expiresAt: new Date('2026-07-06T12:10:00.000Z'),
  origin: 'staff',
  sourceKey: USER,
  appointmentId: null,
  ...overrides,
});

const occupancyOf = (record: HoldRecord): ActiveOccupancy => ({
  id: record.id,
  kind: 'hold',
  locationId: record.locationId,
  lane: record.lane,
  start: record.startsAt.getTime(),
  end: record.endsAt.getTime(),
  holdOrigin: record.origin,
});

const request = {
  professionalId: DOCTOR,
  locationId: CENTRO,
  appointmentTypeId: 'type-30',
  local: { date: '2026-07-13', time: '10:00' },
};

const make = (
  ports: ReturnType<typeof world>['ports'],
  extra: Partial<Parameters<typeof createHold>[1]> = {},
) =>
  createHold(ports, {
    request,
    actor,
    now: NOW,
    origin: 'staff',
    sourceKey: USER,
    ...extra,
  });

const thrown = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('creating a hold', () => {
  it('reserves the range for ten minutes without a patient or an appointment status', async () => {
    const { ports, state } = world();

    const created = await make(ports);

    expect(created).toMatchObject({
      status: 'active',
      origin: 'staff',
      startsAt: '2026-07-13T13:00:00.000Z',
      endsAt: '2026-07-13T13:30:00.000Z',
      expiresAt: new Date(NOW.getTime() + HOLD_MINUTES * 60_000).toISOString(),
    });
    expect(HOLD_MINUTES).toBe(10);
    expect(state.holds.get(created.id)).toMatchObject({ lane: 1, sourceKey: USER });
    // A hold is not an appointment: nothing in the history or the audit trail.
    expect(state.events).toEqual([]);
    expect(state.inserted).toEqual([]);
  });

  it('occupies time like an appointment, buffer included', async () => {
    const { ports, state } = world();
    const type = state.types.get('type-30');
    if (type) type.bufferMinutes = 10;

    const created = await make(ports);

    expect(state.holds.get(created.id)?.bufferMinutes).toBe(10);
  });

  it('applies the hours, blocks and holidays of a booking, with no way to override them', async () => {
    const { ports } = world();

    const error = await thrown(
      make(ports, { request: { ...request, local: { date: '2026-07-13', time: '16:00' } } }),
    );

    expect((error as AppError).fieldErrors[0]?.i18nKey).toBe(
      'scheduling.booking.outside_working_hours',
    );
  });

  it('is a conflict when the range is taken', async () => {
    const { ports } = world({
      occupancies: [
        {
          id: 'a',
          kind: 'appointment',
          locationId: CENTRO,
          lane: 1,
          start: utc('2026-07-13T13:00:00Z'),
          end: utc('2026-07-13T13:30:00Z'),
        },
      ],
    });

    expect(await thrown(make(ports))).toBeInstanceOf(SlotTakenError);
  });

  it('is bounded per source: a new hold releases the previous one of the same source', async () => {
    const { ports, state } = world();

    await make(ports);
    const second = await make(ports, {
      request: { ...request, local: { date: '2026-07-13', time: '11:00' } },
    });

    const statuses = [...state.holds.values()].map((record) => [
      record.startsAt.toISOString(),
      record.status,
    ]);
    expect(statuses).toEqual([
      ['2026-07-13T13:00:00.000Z', 'released'],
      ['2026-07-13T14:00:00.000Z', 'active'],
    ]);
    expect(second.status).toBe('active');
  });

  it('keeps the newest ones when the bound is higher, and never touches another source', async () => {
    const { ports, state } = world();

    await make(ports, { bound: 2 });
    await make(ports, {
      bound: 2,
      request: { ...request, local: { date: '2026-07-13', time: '11:00' } },
    });
    await make(ports, {
      bound: 2,
      sourceKey: 'someone-else',
      request: { ...request, local: { date: '2026-07-13', time: '12:00' } },
    });
    await make(ports, {
      bound: 2,
      request: { ...request, local: { date: '2026-07-13', time: '12:30' } },
    });

    const bySource = [...state.holds.values()].map((record) => [
      record.sourceKey,
      record.startsAt.toISOString().slice(11, 16),
      record.status,
    ]);
    expect(bySource).toEqual([
      [USER, '13:00', 'released'],
      [USER, '14:00', 'active'],
      ['someone-else', '15:00', 'active'],
      [USER, '15:30', 'active'],
    ]);
  });

  it('lets a source hold the very slot it already holds (the old hold is released first)', async () => {
    const { ports, state } = world();

    await make(ports);
    const again = await make(ports);

    expect(again.status).toBe('active');
    expect([...state.holds.values()].map((record) => record.status)).toEqual([
      'released',
      'active',
    ]);
  });

  it('uses capacity 1 for a public hold, whatever the professional allows', async () => {
    const busy: ActiveOccupancy = {
      id: 'a',
      kind: 'appointment',
      locationId: CENTRO,
      lane: 1,
      start: utc('2026-07-13T13:00:00Z'),
      end: utc('2026-07-13T13:30:00Z'),
    };
    const staff = world({ occupancies: [busy] }, 2);
    const pub = world({ occupancies: [{ ...busy }] }, 2);

    const staffHold = await make(staff.ports);
    const publicHold = await thrown(
      make(pub.ports, { origin: 'public', sourceKey: 'anonymous-session' }),
    );

    // Staff may take the second lane; the public flow may not.
    expect(staff.state.holds.get(staffHold.id)?.lane).toBe(2);
    expect(publicHold).toBeInstanceOf(SlotTakenError);
  });

  it('puts a public hold in lane 1', async () => {
    const { ports, state } = world({}, 2);

    const created = await make(ports, { origin: 'public', sourceKey: 'anonymous-session' });

    expect(state.holds.get(created.id)).toMatchObject({ lane: 1, origin: 'public' });
  });

  it('needs the professional, location and type to exist and be active', async () => {
    const { ports } = world();

    expect(
      (
        (await thrown(
          make(ports, { request: { ...request, professionalId: 'nobody' } }),
        )) as AppError
      ).code,
    ).toBe('not_found');
    expect(
      (
        (await thrown(
          make(ports, { request: { ...request, appointmentTypeId: 'nobody' } }),
        )) as AppError
      ).code,
    ).toBe('not_found');
  });
});

describe('releasing a hold', () => {
  it('lets the holder give it up, freeing the range', async () => {
    const { ports, state } = world();
    const created = await make(ports);

    const released = await releaseHold(ports, { holdId: created.id, sourceKey: USER, now: NOW });

    expect(released.status).toBe('released');
    expect(state.holds.get(created.id)?.status).toBe('released');
  });

  it('is not found for a hold of another source, and a conflict when it already ended', async () => {
    const { ports } = world();
    const created = await make(ports);

    expect(
      (
        (await thrown(
          releaseHold(ports, { holdId: created.id, sourceKey: 'other', now: NOW }),
        )) as AppError
      ).code,
    ).toBe('not_found');
    await releaseHold(ports, { holdId: created.id, sourceKey: USER, now: NOW });
    expect(
      (
        (await thrown(
          releaseHold(ports, { holdId: created.id, sourceKey: USER, now: NOW }),
        )) as AppError
      ).code,
    ).toBe('conflict');
  });
});

describe('converting a hold into an appointment', () => {
  const convert = (
    ports: ReturnType<typeof world>['ports'],
    extra: Partial<Parameters<typeof bookAppointment>[1]['request']> = {},
    now = NOW,
  ) =>
    bookAppointment(ports, {
      request: { ...request, patientId: 'patient-1', holdId: 'hold-1', ...extra },
      actor,
      auditActor,
      now,
    });

  const withHold = (record = hold()) =>
    world({ holds: new Map([[record.id, record]]), occupancies: [occupancyOf(record)] });

  it('re-runs the booking validations, frees the hold first and links it to the appointment', async () => {
    const { ports, state } = withHold();

    const appointment = await convert(ports);

    expect(appointment).toMatchObject({
      status: 'scheduled',
      startsAt: '2026-07-13T13:00:00.000Z',
    });
    expect(state.holdUpdates.map((update) => update.patch)).toEqual([
      { status: 'converted' },
      { appointmentId: appointment.id },
    ]);
    expect(state.holds.get('hold-1')).toMatchObject({
      status: 'converted',
      appointmentId: appointment.id,
    });
  });

  it.each(['invalidated', 'expired', 'released', 'converted'] as const)(
    'answers slot no longer available when the hold is %s',
    async (status) => {
      const { ports, state } = withHold(hold({ status }));

      const error = await thrown(convert(ports));

      expect(error).toBeInstanceOf(SlotNoLongerAvailableError);
      expect(state.inserted).toEqual([]);
    },
  );

  it('treats a hold that ran out of time as expired', async () => {
    const { ports } = withHold(hold({ expiresAt: new Date('2026-07-06T11:59:00.000Z') }));

    expect(await thrown(convert(ports))).toBeInstanceOf(SlotNoLongerAvailableError);
  });

  it('refuses a hold that is for another range', async () => {
    const { ports } = withHold();

    const error = await thrown(convert(ports, { local: { date: '2026-07-13', time: '11:00' } }));

    expect((error as AppError).fieldErrors[0]?.i18nKey).toBe('scheduling.hold.mismatch');
  });

  it('does not find the hold of another source', async () => {
    const { ports } = withHold(hold({ sourceKey: 'someone-else' }));

    expect(((await thrown(convert(ports))) as AppError).code).toBe('not_found');
  });

  it('is still refused when something else took the range after the hold was made', async () => {
    const record = hold();
    const { ports } = world({
      holds: new Map([[record.id, record]]),
      occupancies: [
        occupancyOf(record),
        {
          id: 'a',
          kind: 'appointment',
          locationId: CENTRO,
          lane: 1,
          start: utc('2026-07-13T13:00:00Z'),
          end: utc('2026-07-13T13:30:00Z'),
        },
      ],
    });

    expect(await thrown(convert(ports))).toBeInstanceOf(SlotTakenError);
  });
});
