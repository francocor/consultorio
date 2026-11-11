import { describe, expect, it } from 'vitest';

import { validateLeadTimes } from './lead-times.js';

describe('validateLeadTimes', () => {
  it('turns what was typed into whole hours when every entry is right', () => {
    expect(validateLeadTimes(['24', ' 48 ', '2'])).toEqual({
      hours: [24, 48, 2],
      errors: [null, null, null],
    });
  });

  it('accepts no entry at all: that switches reminders off', () => {
    expect(validateLeadTimes([])).toEqual({ hours: [], errors: [] });
  });

  it('asks for the hours when an entry is empty', () => {
    expect(validateLeadTimes(['24', ' '])).toEqual({
      hours: null,
      errors: [null, 'messaging:reminders.error.required'],
    });
  });

  it.each(['0', '337', '-3', '1.5', 'abc', '2e1', '12h'])(
    'refuses %j: only whole hours between 1 and 336',
    (typed) => {
      expect(validateLeadTimes([typed])).toEqual({
        hours: null,
        errors: ['messaging:reminders.error.range'],
      });
    },
  );

  it('accepts the limits, 1 and 336 hours', () => {
    expect(validateLeadTimes(['1', '336']).hours).toEqual([1, 336]);
  });

  it('flags a repeated number on the later entry only', () => {
    expect(validateLeadTimes(['24', '48', '24'])).toEqual({
      hours: null,
      errors: [null, null, 'messaging:reminders.error.repeated'],
    });
  });
});
