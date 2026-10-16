import { describe, expect, it } from 'vitest';

import {
  ChangeRolesRequest,
  CreateLocationRequest,
  DEFAULT_SHARED_TEMPLATES,
  GrantPermissionRequest,
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
