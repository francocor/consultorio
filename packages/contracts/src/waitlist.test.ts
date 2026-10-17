import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import { WAITLIST_AUDIT_ACTIONS, WAITLIST_ERRORS } from './waitlist-catalog.js';
import {
  CreateWaitlistEntryRequest,
  DEFAULT_WAITLIST_SETTINGS,
  PublicWaitlistJoinRequest,
  SetWaitlistPriorityRequest,
  UpdateWaitlistEntryRequest,
  WAITLIST_CLOSE_REASONS,
  WAITLIST_ENTRY_STATUSES,
  WAITLIST_OFFER_STATUSES,
  WaitlistSettings,
} from './waitlist.js';

const PATIENT = '0190a000-0000-7000-8000-000000000001';
const TYPE = '0190a000-0000-7000-8000-000000000002';

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

  it('joins its error codes to the shared catalogue with a translation key each', () => {
    const codes = Object.keys(WAITLIST_ERRORS);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(ERROR_CATALOG).toHaveProperty(code);
      expect(WAITLIST_ERRORS[code as keyof typeof WAITLIST_ERRORS].i18nKey).toBe(`errors.${code}`);
    }
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

describe('creating an entry', () => {
  const base = { patientId: PATIENT, appointmentTypeId: TYPE, offersOptIn: true };

  it('needs only a patient, a type and the opt-in answer, with everything else open', () => {
    const parsed = CreateWaitlistEntryRequest.parse(base);

    expect(parsed.weekdays).toEqual([]);
    expect(parsed.timeRanges).toEqual([]);
    expect(parsed.channels).toEqual(['email']);
  });

  it('keeps weekdays sorted and unique, and refuses a day outside Monday to Sunday', () => {
    expect(CreateWaitlistEntryRequest.parse({ ...base, weekdays: [3, 1, 3] }).weekdays).toEqual([
      1, 3,
    ]);
    expect(CreateWaitlistEntryRequest.safeParse({ ...base, weekdays: [0] }).success).toBe(false);
    expect(CreateWaitlistEntryRequest.safeParse({ ...base, weekdays: [8] }).success).toBe(false);
  });

  it('accepts a time range that ends after it starts and refuses one that does not', () => {
    expect(
      CreateWaitlistEntryRequest.safeParse({
        ...base,
        timeRanges: [{ from: '08:00', to: '12:00' }],
      }).success,
    ).toBe(true);
    expect(
      CreateWaitlistEntryRequest.safeParse({
        ...base,
        timeRanges: [{ from: '12:00', to: '12:00' }],
      }).success,
    ).toBe(false);
    expect(
      CreateWaitlistEntryRequest.safeParse({
        ...base,
        timeRanges: [{ from: '14:00', to: '09:00' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a latest date before the earliest one', () => {
    expect(
      CreateWaitlistEntryRequest.safeParse({
        ...base,
        earliestDate: '2031-06-10',
        latestDate: '2031-06-01',
      }).success,
    ).toBe(false);
    expect(
      CreateWaitlistEntryRequest.safeParse({
        ...base,
        earliestDate: '2031-06-01',
        latestDate: '2031-06-10',
      }).success,
    ).toBe(true);
  });

  it('refuses fields it does not know (a staff request is strict)', () => {
    expect(CreateWaitlistEntryRequest.safeParse({ ...base, tenantId: PATIENT }).success).toBe(
      false,
    );
  });

  it('changes only the preferences in an update and needs at least one field', () => {
    expect(UpdateWaitlistEntryRequest.safeParse({}).success).toBe(false);
    expect(UpdateWaitlistEntryRequest.parse({ weekdays: [2, 4] }).weekdays).toEqual([2, 4]);
    expect(UpdateWaitlistEntryRequest.safeParse({ patientId: PATIENT }).success).toBe(false);
  });

  it('allows three priority levels only', () => {
    expect(SetWaitlistPriorityRequest.parse({ priority: 2 }).priority).toBe(2);
    expect(SetWaitlistPriorityRequest.safeParse({ priority: 3 }).success).toBe(false);
    expect(SetWaitlistPriorityRequest.safeParse({ priority: -1 }).success).toBe(false);
  });
});

describe('the public join form', () => {
  const form = {
    professional: 'abcdefgh1234',
    appointmentTypeId: TYPE,
    givenNames: 'Lucía',
    familyName: 'Fernández',
    document: { type: 'dni', number: '30111222' },
    birthDate: '1990-04-02',
    email: ' LUCIA@Example.test ',
    offersOptIn: true,
    dataProcessingConsent: true,
    challengeProof: 'proof',
  };

  it('normalizes the email and defaults to the email channel', () => {
    const parsed = PublicWaitlistJoinRequest.parse(form);

    expect(parsed.email).toBe('lucia@example.test');
    expect(parsed.channels).toEqual(['email']);
    expect(parsed.weekdays).toEqual([]);
  });

  it('drops a field it does not define instead of rejecting it', () => {
    const parsed = PublicWaitlistJoinRequest.parse({ ...form, tenantId: 'x', role: 'owner' });

    expect(parsed).not.toHaveProperty('tenantId');
    expect(parsed).not.toHaveProperty('role');
  });

  it('needs the proof of the bot challenge', () => {
    const withoutProof = { ...form, challengeProof: undefined };

    expect(PublicWaitlistJoinRequest.safeParse(withoutProof).success).toBe(false);
  });
});
