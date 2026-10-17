import { describe, expect, it } from 'vitest';

import { planReminders } from './reminder-plan.js';

const ZONE = 'America/Argentina/Buenos_Aires';
const QUIET = { start: '21:00', end: '08:00' };
/** A Buenos Aires wall-clock time (UTC-3 all year) as an instant. */
const ba = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`);

const plan = (overrides: Partial<Parameters<typeof planReminders>[0]> = {}) =>
  planReminders({
    now: ba('2031-05-05', '09:00'),
    startsAt: ba('2031-05-12', '10:00'),
    timeZone: ZONE,
    leadHours: [24],
    quiet: QUIET,
    ...overrides,
  });

describe('planReminders', () => {
  it('plans one reminder 24 hours before the start by default, and no confirmation', () => {
    expect(plan()).toEqual({
      reminders: [{ leadHours: 24, sendAt: ba('2031-05-11', '10:00') }],
      quietSkipped: [],
      overdue: [],
      confirmNow: false,
    });
  });

  it('plans up to three reminders, the earliest first', () => {
    const result = plan({ leadHours: [2, 72, 24] });

    expect(result.reminders).toEqual([
      { leadHours: 72, sendAt: ba('2031-05-09', '10:00') },
      { leadHours: 24, sendAt: ba('2031-05-11', '10:00') },
      { leadHours: 2, sendAt: ba('2031-05-12', '08:00') },
    ]);
  });

  it('plans nothing, and no confirmation, when every lead time is off', () => {
    expect(plan({ leadHours: [] })).toEqual({
      reminders: [],
      quietSkipped: [],
      overdue: [],
      confirmNow: false,
    });
  });

  it('skips a reminder that is already overdue and asks for the confirmation instead (last-minute booking)', () => {
    const result = plan({ now: ba('2031-05-12', '07:00') });

    expect(result.reminders).toEqual([]);
    expect(result.overdue).toEqual([24]);
    expect(result.confirmNow).toBe(true);
  });

  it('keeps the reminders that are still ahead and confirms for the one that is overdue', () => {
    const result = plan({ now: ba('2031-05-11', '12:00'), leadHours: [24, 2] });

    expect(result.reminders).toEqual([{ leadHours: 2, sendAt: ba('2031-05-12', '08:00') }]);
    expect(result.overdue).toEqual([24]);
    expect(result.confirmNow).toBe(true);
  });

  it('treats a reminder due this very instant as overdue: it would be sent in the past', () => {
    const result = plan({ now: ba('2031-05-11', '10:00') });

    expect(result.reminders).toEqual([]);
    expect(result.overdue).toEqual([24]);
  });

  it('plans nothing for an appointment that already started', () => {
    expect(plan({ now: ba('2031-05-12', '10:00') })).toEqual({
      reminders: [],
      quietSkipped: [],
      overdue: [],
      confirmNow: false,
    });
  });

  it('defers a reminder that falls due in quiet hours to their end (spec: 07:00 appointment)', () => {
    const result = plan({ startsAt: ba('2031-05-12', '07:00') });

    expect(result.reminders).toEqual([{ leadHours: 24, sendAt: ba('2031-05-11', '08:00') }]);
    expect(result.quietSkipped).toEqual([]);
  });

  it('skips a reminder that cannot be deferred and reports it (spec: 07:30 appointment, 1 hour lead)', () => {
    const result = plan({ startsAt: ba('2031-05-12', '07:30'), leadHours: [1] });

    expect(result.reminders).toEqual([]);
    expect(result.quietSkipped).toEqual([1]);
    expect(result.confirmNow).toBe(false);
  });

  it('does not count a reminder skipped for quiet hours as overdue', () => {
    const result = plan({ startsAt: ba('2031-05-12', '07:30'), leadHours: [24, 1] });

    expect(result.reminders).toEqual([{ leadHours: 24, sendAt: ba('2031-05-11', '08:00') }]);
    expect(result.quietSkipped).toEqual([1]);
    expect(result.overdue).toEqual([]);
  });

  it('ignores a repeated lead time', () => {
    expect(plan({ leadHours: [24, 24] }).reminders).toHaveLength(1);
  });
});
