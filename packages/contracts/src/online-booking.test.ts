import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  CreateBookingLinkRequest,
  DEFAULT_ONLINE_BOOKING_SETTINGS,
  ONLINE_BOOKING_AUDIT_ACTIONS,
  ONLINE_BOOKING_ERRORS,
  OnlineBookingSettings,
  PublicAvailabilityQuery,
  PublicConfirmRequest,
  PublicHoldRequest,
  PublicSubmissionRequest,
  UpdateBookingLinkRequest,
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

describe('booking link contracts', () => {
  it('creates a link for the organization or a professional and lists what it exposes', () => {
    expect(CreateBookingLinkRequest.safeParse({}).success).toBe(true);
    expect(
      CreateBookingLinkRequest.safeParse({
        professionalId: '0190a000-0000-7000-8000-000000000001',
        typeIds: ['0190a000-0000-7000-8000-000000000002'],
        locationIds: [],
      }).success,
    ).toBe(true);
    expect(CreateBookingLinkRequest.safeParse({ slug: 'chosen-by-the-client' }).success).toBe(
      false,
    );
    expect(CreateBookingLinkRequest.safeParse({ tenantId: 'x' }).success).toBe(false);
  });

  it('changes a link only through the fields it may change', () => {
    expect(UpdateBookingLinkRequest.safeParse({ enabled: true }).success).toBe(true);
    expect(UpdateBookingLinkRequest.safeParse({ typeIds: [] }).success).toBe(true);
    expect(UpdateBookingLinkRequest.safeParse({ slug: 'abcdefgh12' }).success).toBe(false);
    expect(UpdateBookingLinkRequest.safeParse({ professionalId: null }).success).toBe(false);
  });
});

describe('public booking contracts', () => {
  const professional = '0190a000-0000-7000-8000-0000000000aa';
  const type = '0190a000-0000-7000-8000-0000000000bb';

  it('asks for availability by the professional link and a range of dates, nothing else', () => {
    const base = { professional: 'abcdefgh12', typeId: type, from: '2031-05-12', to: '2031-05-18' };

    expect(PublicAvailabilityQuery.safeParse(base).success).toBe(true);
    expect(PublicAvailabilityQuery.safeParse({ ...base, to: '2031-05-11' }).success).toBe(false);
    expect(PublicAvailabilityQuery.safeParse({ ...base, to: '2031-07-30' }).success).toBe(false);
    // The tenant and the professional's internal id are not inputs: they are dropped, not used.
    expect(PublicAvailabilityQuery.parse({ ...base, tenantId: professional })).toEqual(base);
    expect(PublicAvailabilityQuery.parse({ ...base, professionalId: professional })).toEqual(base);
  });

  it('holds a slot with a proof of the bot challenge and an instant', () => {
    const base = {
      professional: 'abcdefgh12',
      locationId: type,
      appointmentTypeId: type,
      startsAt: '2031-05-12T13:00:00.000Z',
      challengeProof: 'proof',
    };

    expect(PublicHoldRequest.safeParse(base).success).toBe(true);
    expect(PublicHoldRequest.safeParse({ ...base, challengeProof: '' }).success).toBe(false);
    expect(PublicHoldRequest.safeParse({ ...base, startsAt: 'tomorrow' }).success).toBe(false);
    expect(PublicHoldRequest.parse({ ...base, tenantId: type, role: 'owner' })).toEqual(base);
  });

  it('declares the error codes of the module with a status and a key', () => {
    for (const [code, definition] of Object.entries(ONLINE_BOOKING_ERRORS)) {
      expect(definition.i18nKey, code).toBe(`errors.${code}`);
    }
    expect(ONLINE_BOOKING_ERRORS).toHaveProperty('booking_challenge_failed');
  });
});

describe('public submission contracts', () => {
  const base = {
    givenNames: 'Lucía',
    familyName: 'Fernández',
    document: { type: 'dni' as const, number: '30.111.222' },
    birthDate: '1990-04-02',
    email: 'Lucia@Example.TEST ',
    phone: '+54 11 5555-0000',
    whatsappOptIn: false,
    dataProcessingConsent: true,
    challengeProof: 'proof',
  };

  it('takes the data of the form and normalizes the email', () => {
    const parsed = PublicSubmissionRequest.parse(base);

    expect(parsed.email).toBe('lucia@example.test');
    expect(parsed.whatsappOptIn).toBe(false);
  });

  it('leaves the WhatsApp choice off unless the visitor ticks it', () => {
    const withoutChoice: Record<string, unknown> = { ...base };
    delete withoutChoice['whatsappOptIn'];

    expect(PublicSubmissionRequest.parse(withoutChoice).whatsappOptIn).toBe(false);
  });

  it('refuses what is not a name, a date, an email or a phone number', () => {
    for (const bad of [
      { givenNames: ' ' },
      { familyName: 'x'.repeat(81) },
      { birthDate: 'tomorrow' },
      { email: 'not-an-email' },
      { phone: 'call me' },
      { document: { type: 'cuit', number: '1' } },
      { reason: 'x'.repeat(301) },
      { challengeProof: '' },
    ]) {
      expect(
        PublicSubmissionRequest.safeParse({ ...base, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('has no clinical question: only the optional administrative reason', () => {
    const keys = Object.keys(PublicSubmissionRequest.shape);

    expect(keys).toContain('reason');
    for (const forbidden of ['symptoms', 'diagnosis', 'medication', 'allergies']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('drops an organization, role or patient identifier instead of using it', () => {
    const parsed = PublicSubmissionRequest.parse({
      ...base,
      tenantId: '0190a000-0000-7000-8000-000000000001',
      role: 'owner',
      patientId: '0190a000-0000-7000-8000-000000000002',
    });

    expect(Object.keys(parsed)).not.toEqual(
      expect.arrayContaining(['tenantId', 'role', 'patientId']),
    );
  });

  it('takes a six digit code and nothing else', () => {
    expect(PublicConfirmRequest.safeParse({ code: '012345' }).success).toBe(true);
    for (const code of ['12345', '1234567', 'abcdef', '12 345', '']) {
      expect(PublicConfirmRequest.safeParse({ code }).success, code).toBe(false);
    }
  });
});
