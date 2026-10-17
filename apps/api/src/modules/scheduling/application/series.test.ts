import type { BookSeriesRequest } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { type AppError } from '../../../platform/http/problem.js';
import {
  createFakeSchedulingPorts,
  type FakeSchedulingState,
} from '../../../testing/scheduling-ports.js';
import { AccessRefused } from '../../access/index.js';

import type { BookActor } from './placement.js';
import { bookSeries, SeriesConflictError } from './series.js';

const BA = 'America/Argentina/Buenos_Aires';
const MADRID = 'Europe/Madrid';
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
const actor = (permissions: string[] = []): BookActor => ({
  userId: USER,
  permissions: new Set(['scheduling.book', ...permissions]),
  professionalId: null,
});

function world(overrides: Partial<FakeSchedulingState> = {}, zone = BA, weekdays = [1]) {
  return createFakeSchedulingPorts({
    professionals: new Map([
      [
        DOCTOR,
        { id: DOCTOR, membershipId: 'm', status: 'active', maxSimultaneous: 1, specialties: [] },
      ],
    ]),
    locations: new Map([[CENTRO, { id: CENTRO, timeZone: zone, active: true }]]),
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
    weekly: weekdays.map((weekday) => ({
      locationId: CENTRO,
      weekday,
      startMinute: 0,
      endMinute: 1440,
    })),
    ...overrides,
  });
}

const series = (
  ports: ReturnType<typeof world>['ports'],
  request: Partial<BookSeriesRequest> = {},
  who = actor(),
) =>
  bookSeries(ports, {
    request: {
      patientId: 'patient-1',
      professionalId: DOCTOR,
      locationId: CENTRO,
      appointmentTypeId: 'type-30',
      local: { date: '2026-07-13', time: '10:00' },
      recurrence: { frequency: 'weekly', everyWeeks: 1, count: 6 },
      mode: 'dry_run',
      skip: [],
      ...request,
    },
    actor: who,
    auditActor,
    now: NOW,
  });

const thrown = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('previewing a series (dry run)', () => {
  it('lists every session with its time and creates nothing', async () => {
    const { ports, state } = world();

    const result = await series(ports);

    expect(result.mode).toBe('dry_run');
    if (result.mode !== 'dry_run') return;
    expect(result.canCommit).toBe(true);
    expect(result.occurrences.map((o) => [o.index, o.startsAt, o.status])).toEqual([
      [1, '2026-07-13T13:00:00.000Z', 'ok'],
      [2, '2026-07-20T13:00:00.000Z', 'ok'],
      [3, '2026-07-27T13:00:00.000Z', 'ok'],
      [4, '2026-08-03T13:00:00.000Z', 'ok'],
      [5, '2026-08-10T13:00:00.000Z', 'ok'],
      [6, '2026-08-17T13:00:00.000Z', 'ok'],
    ]);
    expect(state.inserted).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('reports the session that falls on a block and still lists the rest', async () => {
    const { ports } = world({
      blocks: [{ start: utc('2026-08-03T00:00:00Z'), end: utc('2026-08-04T00:00:00Z') }],
    });

    const result = await series(ports);

    if (result.mode !== 'dry_run') throw new Error('expected a preview');
    expect(result.canCommit).toBe(false);
    expect(result.occurrences.filter((o) => o.status === 'conflict')).toEqual([
      expect.objectContaining({ index: 4, reason: 'blocked' }),
    ]);
    expect(result.occurrences.filter((o) => o.status === 'ok')).toHaveLength(5);
  });

  it('reports why each session fails: taken, holiday, outside hours, in the past', async () => {
    const { ports } = world({
      occupancies: [
        {
          id: 'a',
          kind: 'appointment',
          locationId: CENTRO,
          lane: 1,
          start: utc('2026-07-20T13:00:00Z'),
          end: utc('2026-07-20T13:30:00Z'),
        },
      ],
      holidays: [
        {
          day: '2026-07-27',
          name: 'Feriado',
          source: 'national',
          locationId: null,
          dayOffId: null,
        },
      ],
      weekly: [{ locationId: CENTRO, weekday: 1, startMinute: 0, endMinute: 1440 }],
      periods: [
        {
          dateFrom: '2026-08-10',
          dateTo: '2026-08-10',
          rows: [{ locationId: CENTRO, weekday: 1, startMinute: 900, endMinute: 960 }],
        },
      ],
    });

    const result = await series(ports);

    if (result.mode !== 'dry_run') throw new Error('expected a preview');
    expect(result.occurrences.map((o) => o.reason)).toEqual([
      null,
      'slot_taken',
      'holiday',
      null,
      'outside_working_hours',
      null,
    ]);
    const past = await series(ports, { local: { date: '2026-06-29', time: '10:00' } });
    if (past.mode !== 'dry_run') throw new Error('expected a preview');
    expect(past.occurrences[0]).toMatchObject({ status: 'conflict', reason: 'in_past' });
  });

  it('marks the sessions chosen to skip', async () => {
    const { ports } = world();

    const result = await series(ports, { skip: [2, 5] });

    if (result.mode !== 'dry_run') throw new Error('expected a preview');
    expect(result.occurrences.map((o) => o.status)).toEqual([
      'ok',
      'skipped',
      'ok',
      'ok',
      'skipped',
      'ok',
    ]);
  });

  it('supports every other week, and an end date instead of a count', async () => {
    const { ports } = world();

    const biweekly = await series(ports, {
      recurrence: { frequency: 'weekly', everyWeeks: 2, count: 3 },
    });
    const until = await series(ports, {
      recurrence: { frequency: 'weekly', everyWeeks: 1, until: '2026-08-03' },
    });

    if (biweekly.mode !== 'dry_run' || until.mode !== 'dry_run')
      throw new Error('expected previews');
    expect(biweekly.occurrences.map((o) => o.startsAt?.slice(0, 10))).toEqual([
      '2026-07-13',
      '2026-07-27',
      '2026-08-10',
    ]);
    expect(until.occurrences).toHaveLength(4);
  });
});

describe('committing a series', () => {
  it('creates every session at once, tied together and numbered, each audited', async () => {
    const { ports, state } = world();

    const result = await series(ports, { mode: 'commit' });

    if (result.mode !== 'commit') throw new Error('expected a commit');
    expect(result.appointments).toHaveLength(6);
    expect(new Set(state.inserted.map((a) => a.seriesId)).size).toBe(1);
    expect(state.inserted.map((a) => a.seriesIndex)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.seriesId).toBe(state.inserted[0]?.seriesId);
    expect(state.audits.filter((audit) => audit.action === 'appointment.created')).toHaveLength(6);
    expect(state.events.filter((event) => event.kind === 'created')).toHaveLength(6);
  });

  it('creates nothing when a session conflicts and was not skipped', async () => {
    const { ports, state } = world({
      blocks: [{ start: utc('2026-08-03T00:00:00Z'), end: utc('2026-08-04T00:00:00Z') }],
    });

    const error = await thrown(series(ports, { mode: 'commit' }));

    expect(error).toBeInstanceOf(SeriesConflictError);
    expect(
      (error as SeriesConflictError).occurrences
        .filter((o) => o.status === 'conflict')
        .map((o) => o.index),
    ).toEqual([4]);
    expect(state.inserted).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('creates the others when the conflicting session is skipped', async () => {
    const { ports, state } = world({
      blocks: [{ start: utc('2026-08-03T00:00:00Z'), end: utc('2026-08-04T00:00:00Z') }],
    });

    const result = await series(ports, { mode: 'commit', skip: [4] });

    if (result.mode !== 'commit') throw new Error('expected a commit');
    expect(result.appointments).toHaveLength(5);
    expect(result.skipped).toEqual([4]);
    expect(state.inserted.map((a) => a.seriesIndex)).toEqual([1, 2, 3, 5, 6]);
  });

  it('refuses a series where everything is skipped', async () => {
    const { ports } = world();

    const error = await thrown(series(ports, { mode: 'commit', skip: [1, 2, 3, 4, 5, 6] }));

    expect((error as AppError).fieldErrors[0]?.i18nKey).toBe('scheduling.series.nothing_to_create');
  });

  it('lets an authorized user override the hours for the whole series, and refuses anyone else', async () => {
    const closed = {
      weekly: [{ locationId: CENTRO, weekday: 2, startMinute: 0, endMinute: 1440 }],
    };
    const allowed = world(closed);
    const refused = world(closed);
    const request = { mode: 'commit' as const, overrideHours: { reason: 'Rehabilitation block' } };

    const done = await series(allowed.ports, request, actor(['scheduling.override_hours']));
    const denied = await thrown(series(refused.ports, request, actor()));

    if (done.mode !== 'commit') throw new Error('expected a commit');
    expect(done.appointments.every((a) => a.outOfHours)).toBe(true);
    expect(denied).toBeInstanceOf(AccessRefused);
    expect(refused.state.inserted).toEqual([]);
  });

  it('opens one identity review per session when the professional books themselves', async () => {
    const { ports, state } = world();
    const self: BookActor = {
      userId: 'user-b',
      permissions: new Set(['scheduling.book']),
      professionalId: DOCTOR,
    };

    await series(
      ports,
      { mode: 'commit', recurrence: { frequency: 'weekly', everyWeeks: 1, count: 2 } },
      self,
    );

    expect(state.openedItems).toHaveLength(2);
    expect(state.inserted.every((a) => !a.identityConfirmed)).toBe(true);
  });
});

describe('a series for a patient registered a moment ago (D14)', () => {
  const self: BookActor = {
    userId: 'user-b',
    permissions: new Set(['scheduling.book']),
    professionalId: DOCTOR,
  };

  it('confirms every session and opens no identity review: freshness is judged once per series', async () => {
    const { ports, state } = world({ freshPatients: new Set(['patient-1']) });

    await series(
      ports,
      { mode: 'commit', recurrence: { frequency: 'weekly', everyWeeks: 1, count: 3 } },
      self,
    );

    expect(state.inserted).toHaveLength(3);
    expect(state.inserted.every((a) => a.identityConfirmed)).toBe(true);
    expect(state.openedItems).toEqual([]);
  });

  it('keeps every session unconfirmed for an existing patient, as before', async () => {
    const { ports, state } = world();

    await series(
      ports,
      { mode: 'commit', recurrence: { frequency: 'weekly', everyWeeks: 1, count: 3 } },
      self,
    );

    expect(state.inserted.every((a) => !a.identityConfirmed)).toBe(true);
    expect(state.openedItems).toHaveLength(3);
  });
});

describe('sessions and daylight saving time', () => {
  it('keeps the local time of every session across a clock change', async () => {
    const { ports } = world({}, MADRID);

    const result = await series(ports, {
      local: { date: '2026-03-23', time: '10:00' },
      recurrence: { frequency: 'weekly', everyWeeks: 1, count: 3 },
    });

    if (result.mode !== 'dry_run') throw new Error('expected a preview');
    // 23 March is winter time (UTC+1); 30 March and 6 April are summer time (UTC+2).
    expect(result.occurrences.map((o) => o.startsAt)).toEqual([
      '2026-03-23T09:00:00.000Z',
      '2026-03-30T08:00:00.000Z',
      '2026-04-06T08:00:00.000Z',
    ]);
  });

  it('reports a session that lands in the skipped hour, and one that lands in the repeated hour', async () => {
    const spring = world({}, MADRID, [7]);
    const autumn = world({}, MADRID, [7]);

    const gap = await series(spring.ports, {
      local: { date: '2026-03-22', time: '02:30' },
      recurrence: { frequency: 'weekly', everyWeeks: 1, count: 2 },
    });
    const repeated = await series(autumn.ports, {
      local: { date: '2026-10-18', time: '02:30' },
      recurrence: { frequency: 'weekly', everyWeeks: 1, count: 2 },
    });

    if (gap.mode !== 'dry_run' || repeated.mode !== 'dry_run') throw new Error('expected previews');
    expect(gap.occurrences[1]).toMatchObject({
      index: 2,
      status: 'conflict',
      reason: 'local_time_nonexistent',
      startsAt: null,
    });
    expect(repeated.occurrences[1]).toMatchObject({
      index: 2,
      status: 'conflict',
      reason: 'local_time_ambiguous',
    });
  });
});

describe('what must exist', () => {
  it('answers not found for an unknown patient, professional, location or type', async () => {
    const { ports } = world();

    for (const patch of [
      { patientId: 'nobody' },
      { professionalId: 'nobody' },
      { locationId: 'nobody' },
      { appointmentTypeId: 'nobody' },
    ]) {
      expect(((await thrown(series(ports, patch))) as AppError).code).toBe('not_found');
    }
  });
});
