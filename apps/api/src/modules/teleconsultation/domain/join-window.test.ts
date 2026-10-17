import { describe, expect, it } from 'vitest';

import { joinWindowOf, noShowAllowedFrom, windowStateAt } from './join-window.js';

const STARTS = new Date('2031-05-12T13:00:00.000Z');
const ENDS = new Date('2031-05-12T13:30:00.000Z');
const minutes = (date: Date, amount: number) => new Date(date.getTime() + amount * 60_000);

describe('join window', () => {
  it('opens the configured minutes before the start and closes 60 minutes after the end', () => {
    const window = joinWindowOf({ startsAt: STARTS, endsAt: ENDS }, 15);

    expect(window.opensAt.toISOString()).toBe('2031-05-12T12:45:00.000Z');
    expect(window.closesAt.toISOString()).toBe('2031-05-12T14:30:00.000Z');
  });

  it('follows the setting: 0 opens at the start, 60 an hour before', () => {
    expect(joinWindowOf({ startsAt: STARTS, endsAt: ENDS }, 0).opensAt).toEqual(STARTS);
    expect(joinWindowOf({ startsAt: STARTS, endsAt: ENDS }, 60).opensAt.toISOString()).toBe(
      '2031-05-12T12:00:00.000Z',
    );
  });

  it('says early before the window, open inside it and closed after it', () => {
    const window = joinWindowOf({ startsAt: STARTS, endsAt: ENDS }, 15);

    expect(windowStateAt(window, new Date('2031-05-12T12:00:00.000Z'))).toBe('early');
    expect(windowStateAt(window, new Date('2031-05-12T12:44:59.999Z'))).toBe('early');
    expect(windowStateAt(window, window.opensAt)).toBe('open');
    expect(windowStateAt(window, new Date('2031-05-12T13:10:00.000Z'))).toBe('open');
    expect(windowStateAt(window, new Date('2031-05-12T14:30:00.000Z'))).toBe('open');
    expect(windowStateAt(window, new Date('2031-05-12T14:30:00.001Z'))).toBe('closed');
    expect(windowStateAt(window, minutes(ENDS, 120))).toBe('closed');
  });
});

describe('no-show wait', () => {
  it('allows a no-show only after the configured minutes from the start', () => {
    expect(noShowAllowedFrom(STARTS, 15).toISOString()).toBe('2031-05-12T13:15:00.000Z');
    expect(noShowAllowedFrom(STARTS, 1).toISOString()).toBe('2031-05-12T13:01:00.000Z');
  });
});
