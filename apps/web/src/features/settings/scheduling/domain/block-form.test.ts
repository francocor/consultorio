import { describe, expect, it } from 'vitest';

import { blockRange, overlapsRange } from './block-form.js';

const BA = 'America/Argentina/Buenos_Aires';

describe('blockRange', () => {
  it('reads the times in the zone of the location', () => {
    expect(
      blockRange(
        {
          startDate: '2026-11-10',
          startTime: '09:00',
          endDate: '2026-11-10',
          endTime: '13:30',
          allDay: false,
        },
        BA,
      ),
    ).toEqual({
      ok: true,
      startsAt: '2026-11-10T12:00:00.000Z',
      endsAt: '2026-11-10T16:30:00.000Z',
    });
  });

  it('covers whole days from midnight to midnight', () => {
    expect(
      blockRange(
        {
          startDate: '2026-12-20',
          startTime: '',
          endDate: '2026-12-31',
          endTime: '',
          allDay: true,
        },
        BA,
      ),
    ).toEqual({
      ok: true,
      startsAt: '2026-12-20T03:00:00.000Z',
      endsAt: '2027-01-01T03:00:00.000Z',
    });
  });

  it('is a single day when the end date is empty', () => {
    expect(
      blockRange(
        { startDate: '2026-11-10', startTime: '', endDate: '', endTime: '', allDay: true },
        BA,
      ),
    ).toEqual({
      ok: true,
      startsAt: '2026-11-10T03:00:00.000Z',
      endsAt: '2026-11-11T03:00:00.000Z',
    });
  });

  it('refuses an end that is not after the start, and missing dates or times', () => {
    expect(
      blockRange(
        {
          startDate: '2026-11-10',
          startTime: '10:00',
          endDate: '2026-11-10',
          endTime: '10:00',
          allDay: false,
        },
        BA,
      ),
    ).toEqual({ ok: false, error: 'order' });
    expect(
      blockRange(
        {
          startDate: '2026-11-10',
          startTime: '11:00',
          endDate: '2026-11-10',
          endTime: '10:00',
          allDay: false,
        },
        BA,
      ),
    ).toEqual({ ok: false, error: 'order' });
    expect(
      blockRange({ startDate: '', startTime: '', endDate: '', endTime: '', allDay: true }, BA),
    ).toEqual({ ok: false, error: 'missing' });
    expect(
      blockRange(
        {
          startDate: '2026-11-10',
          startTime: '',
          endDate: '2026-11-10',
          endTime: '10:00',
          allDay: false,
        },
        BA,
      ),
    ).toEqual({ ok: false, error: 'missing' });
  });
});

describe('overlapsRange', () => {
  const range = { startsAt: '2026-11-10T12:00:00.000Z', endsAt: '2026-11-10T16:00:00.000Z' };

  it('is true when the appointment touches the block', () => {
    expect(
      overlapsRange(
        { startsAt: '2026-11-10T11:30:00.000Z', endsAt: '2026-11-10T12:30:00.000Z' },
        range,
      ),
    ).toBe(true);
    expect(
      overlapsRange(
        { startsAt: '2026-11-10T13:00:00.000Z', endsAt: '2026-11-10T13:30:00.000Z' },
        range,
      ),
    ).toBe(true);
  });

  it('is false when it ends exactly at the start or starts exactly at the end', () => {
    expect(
      overlapsRange(
        { startsAt: '2026-11-10T11:00:00.000Z', endsAt: '2026-11-10T12:00:00.000Z' },
        range,
      ),
    ).toBe(false);
    expect(
      overlapsRange(
        { startsAt: '2026-11-10T16:00:00.000Z', endsAt: '2026-11-10T17:00:00.000Z' },
        range,
      ),
    ).toBe(false);
  });
});
