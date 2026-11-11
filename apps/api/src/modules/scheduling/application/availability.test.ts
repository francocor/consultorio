import { describe, expect, it } from 'vitest';

import { type AppError } from '../../../platform/http/problem.js';
import {
  createFakeSchedulingPorts,
  type FakeSchedulingState,
} from '../../../testing/scheduling-ports.js';

import { availability } from './availability.js';
import type { ActiveOccupancy, TypeRecord } from './ports.js';

const BA = 'America/Argentina/Buenos_Aires';
const DOCTOR = 'doctor-1';
const CENTRO = 'centro';
const NORTE = 'norte';
const TYPE = 'type-30';
const NOW = new Date('2026-07-06T12:00:00.000Z');
const utc = (text: string) => Date.parse(text);

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
          membershipId: 'm',
          status: 'active',
          maxSimultaneous: options.capacity ?? 1,
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
    // Mondays 09:00-13:00 at Centro; Mondays 14:00-18:00 at Norte.
    weekly: [
      { locationId: CENTRO, weekday: 1, startMinute: 540, endMinute: 780 },
      { locationId: NORTE, weekday: 1, startMinute: 840, endMinute: 1080 },
    ],
    ...overrides,
  });
}

const ask = (
  ports: ReturnType<typeof world>['ports'],
  query: Partial<Parameters<typeof availability>[1]['query']> = {},
  extra: Partial<Parameters<typeof availability>[1]> = {},
) =>
  availability(ports, {
    query: { professionalId: DOCTOR, typeId: TYPE, from: '2026-07-13', to: '2026-07-19', ...query },
    now: NOW,
    visibleLocations: 'all',
    ...extra,
  });

const times = (slots: { startsAt: string; locationId: string }[], locationId = CENTRO) =>
  slots.filter((slot) => slot.locationId === locationId).map((slot) => slot.startsAt.slice(11, 16));

const taken = (
  from: string,
  to: string,
  extra: Partial<ActiveOccupancy> = {},
): ActiveOccupancy => ({
  id: `occ-${from}`,
  kind: 'appointment',
  locationId: CENTRO,
  lane: 1,
  start: utc(from),
  end: utc(to),
  ...extra,
});

describe('availability', () => {
  it('offers the free starts inside the working hours of each location, in the location zone', async () => {
    const { ports } = world();

    const result = await ask(ports);

    // Centro 09:00-13:00 local is 12:00-16:00Z; the last 30 minute start is 12:30 local.
    expect(times(result.slots).slice(0, 3)).toEqual(['12:00', '12:15', '12:30']);
    expect(times(result.slots)).toHaveLength(15);
    expect(times(result.slots).at(-1)).toBe('15:30');
    expect(times(result.slots, NORTE)[0]).toBe('17:00');
    expect(result.slots.every((slot) => slot.date === '2026-07-13')).toBe(true);
    expect(result.closedDays).toEqual([]);
  });

  it('takes out what is occupied, buffer included, in both directions', async () => {
    // 10:00-10:30 plus its own 10 minute buffer occupies until 10:40 (13:40Z).
    const { ports } = world(
      { occupancies: [taken('2026-07-13T13:00:00Z', '2026-07-13T13:40:00Z')] },
      { buffer: 10 },
    );

    const starts = times((await ask(ports)).slots);

    // A new visit is 30 minutes plus its 10 minute buffer: 09:15 still ends (with buffer) at 09:55.
    expect(starts).toContain('12:15');
    expect(starts).not.toContain('12:30'); // its buffer would run into the occupied range
    expect(starts).not.toContain('13:30'); // inside the occupied range
    expect(starts).toContain('13:45'); // after the other buffer
  });

  it('offers a start right after an occupied range, back to back', async () => {
    const { ports } = world({
      occupancies: [taken('2026-07-13T13:00:00Z', '2026-07-13T13:30:00Z')],
    });

    const starts = times((await ask(ports)).slots);

    expect(starts).toContain('12:30'); // ends exactly when the occupied range starts
    expect(starts).not.toContain('12:45');
    expect(starts).not.toContain('13:15');
    expect(starts).toContain('13:30');
  });

  it('counts an active hold like an appointment', async () => {
    const hold = taken('2026-07-13T13:00:00Z', '2026-07-13T13:30:00Z', {
      kind: 'hold',
      holdOrigin: 'public',
    });
    const { ports } = world({ occupancies: [hold] });

    const starts = times((await ask(ports)).slots);

    expect(starts).not.toContain('13:00');
  });

  it('offers nothing inside a block and says nothing about it', async () => {
    const { ports } = world({
      blocks: [{ start: utc('2026-07-13T12:00:00Z'), end: utc('2026-07-13T16:00:00Z') }],
    });

    const result = await ask(ports);

    expect(times(result.slots)).toEqual([]);
    expect(times(result.slots, NORTE).length).toBeGreaterThan(0);
  });

  it('marks a holiday and offers no slot on it', async () => {
    const { ports } = world({
      holidays: [
        {
          day: '2026-07-13',
          name: 'Feriado de prueba',
          source: 'national',
          locationId: null,
          dayOffId: null,
        },
      ],
    });

    const result = await ask(ports);

    expect(result.slots).toEqual([]);
    expect(result.closedDays).toEqual([
      { date: '2026-07-13', locationId: CENTRO, name: 'Feriado de prueba', source: 'national' },
      { date: '2026-07-13', locationId: NORTE, name: 'Feriado de prueba', source: 'national' },
    ]);
  });

  it('applies a day off of one location to that location only', async () => {
    const { ports } = world({
      holidays: [
        {
          day: '2026-07-13',
          name: 'Closure of Norte',
          source: 'organization',
          locationId: NORTE,
          dayOffId: 'x',
        },
      ],
    });

    const result = await ask(ports);

    expect(times(result.slots).length).toBeGreaterThan(0);
    expect(times(result.slots, NORTE)).toEqual([]);
    expect(result.closedDays.map((day) => day.locationId)).toEqual([NORTE]);
  });

  it('never offers the past', async () => {
    const { ports } = world();

    const result = await ask(ports, {}, { now: new Date('2026-07-13T14:10:00.000Z') });

    expect(times(result.slots)[0]).toBe('14:15');
  });

  it('does not offer a location while the professional is busy at another one', async () => {
    const { ports } = world({
      // Busy at Centro 14:00-14:30 local, which is inside Norte's hours (14:00-18:00).
      occupancies: [taken('2026-07-13T17:00:00Z', '2026-07-13T17:30:00Z', { locationId: CENTRO })],
    });

    const result = await ask(ports);

    expect(times(result.slots, NORTE)[0]).toBe('17:30');
  });

  it('keeps the professional out of a location while they are busy at another (capacity does not help)', async () => {
    const { ports } = world(
      {
        weekly: [
          { locationId: CENTRO, weekday: 1, startMinute: 540, endMinute: 780 },
          { locationId: NORTE, weekday: 1, startMinute: 540, endMinute: 780 },
        ],
        occupancies: [taken('2026-07-13T13:00:00Z', '2026-07-13T13:30:00Z', { locationId: NORTE })],
      },
      { capacity: 3 },
    );

    const result = await ask(ports, { locationId: CENTRO });

    expect(times(result.slots)).not.toContain('13:00');
    expect(times(result.slots)).toContain('12:30');
  });

  it('uses the capacity of the professional for a staff view', async () => {
    const { ports } = world(
      { occupancies: [taken('2026-07-13T13:00:00Z', '2026-07-13T13:30:00Z')] },
      { capacity: 2 },
    );

    expect(times((await ask(ports)).slots)).toContain('13:00');
  });

  it('restricts to one location, and to the locations the viewer may see', async () => {
    const { ports } = world();

    const onlyNorte = await ask(ports, { locationId: NORTE });
    const scoped = await ask(ports, {}, { visibleLocations: [CENTRO] });
    const none = await ask(ports, {}, { visibleLocations: [] });

    expect(new Set(onlyNorte.slots.map((slot) => slot.locationId))).toEqual(new Set([NORTE]));
    expect(new Set(scoped.slots.map((slot) => slot.locationId))).toEqual(new Set([CENTRO]));
    expect(none.slots).toEqual([]);
  });

  it('reads a period of dates in place of the weekly hours', async () => {
    const { ports } = world({
      periods: [
        {
          dateFrom: '2026-07-13',
          dateTo: '2026-07-13',
          rows: [{ locationId: CENTRO, weekday: 1, startMinute: 600, endMinute: 660 }],
        },
      ],
    });

    const result = await ask(ports, { locationId: CENTRO });

    expect(times(result.slots)).toEqual(['13:00', '13:15', '13:30']);
  });

  it('covers several days and keeps them in order', async () => {
    const { ports } = world();

    const result = await ask(ports, { from: '2026-07-13', to: '2026-07-27', locationId: CENTRO });

    expect(new Set(result.slots.map((slot) => slot.date))).toEqual(
      new Set(['2026-07-13', '2026-07-20', '2026-07-27']),
    );
    expect(result.slots.map((slot) => slot.startsAt)).toEqual(
      [...result.slots.map((slot) => slot.startsAt)].sort(),
    );
  });
});

describe('what availability needs to exist', () => {
  it('answers not found for an unknown professional, type or location', async () => {
    const { ports } = world();

    for (const query of [
      { professionalId: 'nobody' },
      { typeId: 'nobody' },
      { locationId: 'nobody' },
    ]) {
      const error = await ask(ports, query).catch((caught: unknown) => caught);
      expect((error as AppError).code).toBe('not_found');
    }
  });

  it('offers nothing for an inactive type or professional, and refuses a type the professional does not offer', async () => {
    const inactive = world();
    const restricted = world();
    const patches: [typeof inactive, Partial<TypeRecord>][] = [
      [inactive, { active: false }],
      [restricted, { professionalIds: ['someone-else'] }],
    ];
    for (const [fake, patch] of patches) {
      const type = fake.state.types.get(TYPE);
      if (type) fake.state.types.set(TYPE, { ...type, ...patch });
    }

    expect(((await ask(inactive.ports).catch((e: unknown) => e)) as AppError).code).toBe(
      'conflict',
    );
    expect(((await ask(restricted.ports).catch((e: unknown) => e)) as AppError).code).toBe(
      'validation_failed',
    );
  });
});
