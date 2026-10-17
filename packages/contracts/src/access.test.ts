import { describe, expect, it } from 'vitest';

import {
  ChangeRolesRequest,
  CreateLocationRequest,
  DEFAULT_SHARED_TEMPLATES,
  DEFAULT_SETTINGS_SECTIONS,
  GrantPermissionRequest,
  SETTINGS_SECTION_KEYS,
  SettingsDto,
  UpdateLocationRequest,
  UpdateSettingsRequest,
  isKnownTimeZone,
} from './access.js';

describe('access contracts', () => {
  it('has no tenant or role-claim field anywhere (the session decides)', () => {
    expect(
      GrantPermissionRequest.safeParse({ permission: 'cash.operate', tenantId: 'x' }).success,
    ).toBe(false);
    expect(ChangeRolesRequest.safeParse({ roles: ['admin'], role: 'owner' }).success).toBe(false);
  });

  it('accepts any permission string in a grant request: the server decides and audits', () => {
    expect(GrantPermissionRequest.safeParse({ permission: 'clinical.note.read' }).success).toBe(
      true,
    );
  });

  it('refuses a delegated-calendar scope that is empty or not made of ids', () => {
    expect(
      GrantPermissionRequest.safeParse({
        permission: 'scheduling.delegated_calendar',
        scope: { professionalIds: [] },
      }).success,
    ).toBe(false);
    expect(
      GrantPermissionRequest.safeParse({
        permission: 'scheduling.delegated_calendar',
        scope: { professionalIds: ['nope'] },
      }).success,
    ).toBe(false);
  });

  it.each([[[]], [['patient']], [['owner', 'owner']], [['superuser']]])(
    'refuses the role list %j',
    (roles) => {
      expect(ChangeRolesRequest.safeParse({ roles }).success).toBe(false);
    },
  );

  it('accepts a set of distinct staff roles', () => {
    expect(ChangeRolesRequest.parse({ roles: ['professional', 'owner'] }).roles).toEqual([
      'professional',
      'owner',
    ]);
  });
});

describe('time zones', () => {
  it.each(['America/Argentina/Buenos_Aires', 'UTC', 'Europe/Madrid'])('knows %s', (zone) => {
    expect(isKnownTimeZone(zone)).toBe(true);
  });

  it.each(['', 'Buenos_Aires', 'America/Nowhere', 'GMT+3', "America/'; drop"])(
    'refuses %j',
    (zone) => {
      expect(isKnownTimeZone(zone)).toBe(false);
    },
  );

  it('lets a location be created without a zone, and refuses an unknown one', () => {
    expect(CreateLocationRequest.safeParse({ name: 'Centro' }).success).toBe(true);
    expect(CreateLocationRequest.safeParse({ name: 'Centro', timeZone: 'Mars/Base' }).success).toBe(
      false,
    );
    expect(CreateLocationRequest.safeParse({ name: '   ' }).success).toBe(false);
    expect(UpdateLocationRequest.safeParse({}).success).toBe(false);
  });
});

describe('settings contracts', () => {
  it('keeps psychology out of the default shared scope', () => {
    expect(DEFAULT_SHARED_TEMPLATES).not.toContain('psychology');
    expect(DEFAULT_SHARED_TEMPLATES).toContain('general');
  });

  it('needs at least one real change, and the confirmation alone is not one', () => {
    expect(UpdateSettingsRequest.safeParse({}).success).toBe(false);
    expect(UpdateSettingsRequest.safeParse({ confirmPsychologySharing: true }).success).toBe(false);
    expect(UpdateSettingsRequest.safeParse({ clinicalSharing: false }).success).toBe(true);
  });

  it('refuses unknown templates and malformed quiet hours', () => {
    expect(UpdateSettingsRequest.safeParse({ sharedTemplates: ['cardiology'] }).success).toBe(
      false,
    );
    expect(
      UpdateSettingsRequest.safeParse({ quietHours: { start: '25:00', end: '08:00' } }).success,
    ).toBe(false);
  });
});

describe('settings sections of the patient-engagement stages', () => {
  const sections = {
    notifications: { reminderLeadHours: [24], hideProfessional: false, hideAppointmentType: false },
    onlineBooking: {
      minLeadHours: 2,
      horizonDays: 60,
      dailyCap: null,
      rescheduleDeadlineHours: 12,
      requireApproval: false,
    },
    waitlist: {
      entryExpiryDays: 60,
      offerWindowMinutes: 30,
      minOfferLeadMinutes: 60,
      maxActiveEntries: 5,
    },
    teleconsultation: { joinOpensMinutes: 15, noShowAfterMinutes: 15 },
    integrations: { whatsapp: true, video: true },
  };
  const core = {
    receptionSeesClinicalMetadata: false,
    clinicalSharing: false,
    sharedTemplates: [],
    require2fa: false,
    quietHours: { start: '21:00', end: '08:00' },
  };

  it('returns every section next to the core settings', () => {
    expect(SettingsDto.parse({ ...core, ...sections })).toEqual({ ...core, ...sections });
    expect(SettingsDto.safeParse(core).success).toBe(false);
  });

  it('has a default for every section, and they are the values of the example above', () => {
    expect(DEFAULT_SETTINGS_SECTIONS).toEqual(sections);
    expect(Object.keys(DEFAULT_SETTINGS_SECTIONS).sort()).toEqual(
      [...SETTINGS_SECTION_KEYS].sort(),
    );
  });

  it('takes a partial change of one section', () => {
    expect(
      UpdateSettingsRequest.safeParse({ notifications: { hideProfessional: true } }).success,
    ).toBe(true);
    expect(UpdateSettingsRequest.safeParse({ integrations: { whatsapp: false } }).success).toBe(
      true,
    );
  });

  it('refuses an unknown section, an unknown field and an invalid value', () => {
    expect(UpdateSettingsRequest.safeParse({ billing: { enabled: true } }).success).toBe(false);
    expect(UpdateSettingsRequest.safeParse({ waitlist: { priority: 'high' } }).success).toBe(false);
    expect(UpdateSettingsRequest.safeParse({ waitlist: { maxActiveEntries: 0 } }).success).toBe(
      false,
    );
    expect(UpdateSettingsRequest.safeParse({ notifications: {} }).success).toBe(false);
  });
});
