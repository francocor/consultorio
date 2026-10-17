import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  DEFAULT_ONLINE_BOOKING_SETTINGS,
  ONLINE_BOOKING_AUDIT_ACTIONS,
  OnlineBookingSettings,
} from './online-booking.js';

describe('online booking settings', () => {
  it('defaults to the values of the spec: 2 hours of lead, 60 days, 12 hours to change, no approval', () => {
    expect(OnlineBookingSettings.parse(DEFAULT_ONLINE_BOOKING_SETTINGS)).toEqual({
      minLeadHours: 2,
      horizonDays: 60,
      dailyCap: null,
      rescheduleDeadlineHours: 12,
      requireApproval: false,
    });
  });

  it('takes an optional daily cap and bounds every number', () => {
    const base = DEFAULT_ONLINE_BOOKING_SETTINGS;

    expect(OnlineBookingSettings.safeParse({ ...base, dailyCap: 20 }).success).toBe(true);
    expect(OnlineBookingSettings.safeParse({ ...base, dailyCap: 0 }).success).toBe(false);
    expect(OnlineBookingSettings.safeParse({ ...base, horizonDays: 0 }).success).toBe(false);
    expect(OnlineBookingSettings.safeParse({ ...base, horizonDays: 366 }).success).toBe(false);
    expect(OnlineBookingSettings.safeParse({ ...base, minLeadHours: -1 }).success).toBe(false);
    expect(OnlineBookingSettings.safeParse({ ...base, tenantId: 'x' }).success).toBe(false);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(ONLINE_BOOKING_AUDIT_ACTIONS).toEqual([
      'booking.link.enabled',
      'booking.link.disabled',
      'booking.link.regenerated',
      'booking.online.created',
      'booking.suspicious',
    ]);
    for (const action of ONLINE_BOOKING_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });
});
