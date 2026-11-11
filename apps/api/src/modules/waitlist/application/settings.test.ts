import { DEFAULT_QUIET_HOURS, DEFAULT_WAITLIST_SETTINGS } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { readWaitlistConfig } from './settings.js';

describe('the waitlist settings of an organization', () => {
  it('are the defaults when nothing was stored', () => {
    expect(readWaitlistConfig({})).toEqual({
      waitlist: DEFAULT_WAITLIST_SETTINGS,
      quietHours: DEFAULT_QUIET_HOURS,
    });
  });

  it('keep what was set and fill in the rest', () => {
    const config = readWaitlistConfig({
      waitlist: { maxActiveEntries: 2, offerWindowMinutes: 45 },
      quiet_hours: { start: '22:00', end: '07:00' },
    });

    expect(config.waitlist).toEqual({
      ...DEFAULT_WAITLIST_SETTINGS,
      maxActiveEntries: 2,
      offerWindowMinutes: 45,
    });
    expect(config.quietHours).toEqual({ start: '22:00', end: '07:00' });
  });

  it('fall back to the defaults when a section is damaged, never to something half valid', () => {
    expect(readWaitlistConfig({ waitlist: { maxActiveEntries: 'many' } }).waitlist).toEqual(
      DEFAULT_WAITLIST_SETTINGS,
    );
    expect(readWaitlistConfig({ waitlist: 'broken', quiet_hours: { start: 'x' } })).toEqual({
      waitlist: DEFAULT_WAITLIST_SETTINGS,
      quietHours: DEFAULT_QUIET_HOURS,
    });
  });
});
