import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  DEFAULT_WAITLIST_SETTINGS,
  WAITLIST_AUDIT_ACTIONS,
  WAITLIST_CLOSE_REASONS,
  WAITLIST_ENTRY_STATUSES,
  WAITLIST_OFFER_STATUSES,
  WaitlistSettings,
} from './waitlist.js';

describe('waitlist catalogues', () => {
  it('has the statuses and close reasons of the spec', () => {
    expect([...WAITLIST_ENTRY_STATUSES]).toEqual(['active', 'paused', 'offered', 'closed']);
    expect([...WAITLIST_OFFER_STATUSES]).toEqual([
      'open',
      'accepted',
      'declined',
      'expired',
      'invalidated',
    ]);
    expect([...WAITLIST_CLOSE_REASONS]).toEqual([
      'fulfilled',
      'expired',
      'cancelled',
      'patient_opted_out',
    ]);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(WAITLIST_AUDIT_ACTIONS).toEqual([
      'waitlist.entry.created',
      'waitlist.entry.updated',
      'waitlist.entry.closed',
      'waitlist.offer.created',
      'waitlist.offer.accepted',
      'waitlist.offer.declined',
      'waitlist.offer.expired',
      'waitlist.priority.overridden',
    ]);
    for (const action of WAITLIST_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });
});

describe('waitlist settings', () => {
  it('defaults to 60 days, a 30 minute offer, a 1 hour lead and 5 active entries', () => {
    expect(WaitlistSettings.parse(DEFAULT_WAITLIST_SETTINGS)).toEqual({
      entryExpiryDays: 60,
      offerWindowMinutes: 30,
      minOfferLeadMinutes: 60,
      maxActiveEntries: 5,
    });
  });

  it('bounds every number and refuses unknown keys', () => {
    const base = DEFAULT_WAITLIST_SETTINGS;

    expect(WaitlistSettings.safeParse({ ...base, maxActiveEntries: 0 }).success).toBe(false);
    expect(WaitlistSettings.safeParse({ ...base, offerWindowMinutes: 1 }).success).toBe(false);
    expect(WaitlistSettings.safeParse({ ...base, entryExpiryDays: 30 }).success).toBe(true);
    expect(WaitlistSettings.safeParse({ ...base, priority: 'high' }).success).toBe(false);
  });
});
