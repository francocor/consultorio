import {
  GRANTABLE,
  PERMISSIONS,
  PORTAL_ACTOR_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  effectivePermissions,
  isClinicalPermission,
  type Permission,
  type Role,
} from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import type { Actor } from './actor.js';
import { can } from './can.js';

const TENANT = '0190a000-0000-7000-8000-0000000000e1';
const OTHER_TENANT = '0190a000-0000-7000-8000-0000000000e2';
const PROFESSIONAL_ID = '0190a000-0000-7000-8000-0000000000f1';

function staff(roles: Role[], extra: Partial<Actor> = {}): Actor {
  return {
    kind: 'staff',
    userId: '0190a000-0000-7000-8000-0000000000a1',
    tenantId: TENANT,
    membershipId: '0190a000-0000-7000-8000-0000000000a2',
    roles,
    grants: [],
    professionalId: null,
    ...extra,
  };
}

/** A professional whose profile passed the gate. */
const clinician = (extra: Partial<Actor> = {}) =>
  staff(['professional'], { professionalId: PROFESSIONAL_ID, ...extra });

describe('role x permission, straight from the catalog (authorization, "Server-side enforcement")', () => {
  const nonClinical = PERMISSIONS.filter((permission) => !isClinicalPermission(permission));

  it.each(ROLES.filter((role) => role !== 'patient'))(
    '%s may do exactly what the catalog gives the role',
    (role) => {
      const actor = staff([role]);
      for (const permission of nonClinical) {
        const expected = ROLE_PERMISSIONS[role].includes(permission);
        expect(can(actor, permission).allowed, `${role} ${permission}`).toBe(expected);
      }
    },
  );

  it('lets a professional with a valid profile do the clinical things the catalog gives them', () => {
    for (const permission of ROLE_PERMISSIONS.professional.filter(isClinicalPermission)) {
      expect(can(clinician(), permission), permission).toEqual({ allowed: true });
    }
  });

  it('never lets owner, admin or reception do anything clinical, whatever else they hold', () => {
    for (const role of ['owner', 'admin', 'reception'] as Role[]) {
      for (const permission of PERMISSIONS.filter(isClinicalPermission)) {
        expect(can(staff([role]), permission), `${role} ${permission}`).toEqual({
          allowed: false,
          reason: 'not_permitted',
        });
      }
    }
  });

  it('keeps a professional out of clinical work until the professional gate gives them an id', () => {
    for (const permission of PERMISSIONS.filter(isClinicalPermission)) {
      expect(can(staff(['professional']), permission)).toEqual({
        allowed: false,
        reason: 'professional_gate',
      });
    }
  });

  it('an owner who is also a professional is clinical only through the professional profile', () => {
    expect(can(staff(['owner', 'professional']), 'clinical.note.read')).toEqual({
      allowed: false,
      reason: 'professional_gate',
    });
    expect(
      can(
        staff(['owner', 'professional'], { professionalId: PROFESSIONAL_ID }),
        'clinical.note.read',
      ),
    ).toEqual({ allowed: true });
    // The owner role alone grants nothing clinical, even with a profile id lying around.
    expect(
      can(staff(['owner'], { professionalId: PROFESSIONAL_ID }), 'clinical.note.read'),
    ).toEqual({
      allowed: false,
      reason: 'not_permitted',
    });
  });
});

describe('grantable permissions', () => {
  it('adds the grantable permissions of the user to the role', () => {
    const reception = staff(['reception'], { grants: ['scheduling.override_hours'] });

    expect(can(staff(['reception']), 'scheduling.override_hours').allowed).toBe(false);
    expect(can(reception, 'scheduling.override_hours')).toEqual({ allowed: true });
  });

  it('lets a professional hold a grant such as the cash register', () => {
    expect(can(clinician({ grants: ['cash.operate'] }), 'cash.operate')).toEqual({ allowed: true });
  });

  it('ignores a grant that is not on the grantable list, such as a clinical permission', () => {
    for (const forbidden of [
      'clinical.note.read',
      'clinical.note.write',
      'staff.manage',
      'billing.manage',
    ]) {
      const actor = staff(['reception'], { grants: [forbidden] });
      expect(can(actor, forbidden as Permission).allowed, forbidden).toBe(false);
    }
    expect(effectivePermissions(['reception'], ['clinical.note.read'])).not.toContain(
      'clinical.note.read',
    );
  });

  it('knows the grantable list is made only of non-clinical permissions', () => {
    expect(GRANTABLE.some(isClinicalPermission)).toBe(false);
  });
});

describe('failing closed', () => {
  it('denies an action that is not in the catalog', () => {
    expect(can(staff(['owner']), 'patients.delete_everything')).toEqual({
      allowed: false,
      reason: 'unknown_action',
    });
    expect(can(staff(['owner']), '')).toEqual({ allowed: false, reason: 'unknown_action' });
    expect(can(staff(['owner']), 'clinical.*')).toEqual({
      allowed: false,
      reason: 'unknown_action',
    });
  });

  it('denies an actor with no role', () => {
    expect(can(staff([]), 'patients.read')).toEqual({ allowed: false, reason: 'invalid_actor' });
  });

  it('denies an actor without a tenant', () => {
    expect(can(staff(['owner'], { tenantId: '' }), 'patients.read')).toEqual({
      allowed: false,
      reason: 'invalid_actor',
    });
  });

  it('denies a role that is not in the catalog', () => {
    expect(can(staff(['superuser' as Role]), 'patients.read').allowed).toBe(false);
  });

  it('denies a resource of another tenant, however powerful the actor', () => {
    expect(can(staff(['owner']), 'patients.read', { tenantId: OTHER_TENANT })).toEqual({
      allowed: false,
      reason: 'cross_tenant',
    });
    expect(can(staff(['owner']), 'patients.read', { tenantId: TENANT })).toEqual({ allowed: true });
  });
});

describe('the patient actor class (default deny on every staff route)', () => {
  const patient: Actor = { ...staff(['patient']), kind: 'patient' };

  it('is denied every permission that is not one of the portal actor', () => {
    const staffPermissions = PERMISSIONS.filter(
      (permission) => !PORTAL_ACTOR_PERMISSIONS.some((held) => held === permission),
    );

    expect(staffPermissions.length).toBeGreaterThan(20);
    for (const permission of staffPermissions) {
      expect(can(patient, permission).allowed, permission).toBe(false);
    }
  });

  it('is denied staff permissions even if it somehow carried staff roles or grants', () => {
    const disguised: Actor = {
      ...staff(['owner', 'professional'], {
        professionalId: PROFESSIONAL_ID,
        grants: ['cash.operate'],
      }),
      kind: 'patient',
    };

    for (const permission of PERMISSIONS.filter(
      (p) => !PORTAL_ACTOR_PERMISSIONS.some((held) => held === p),
    )) {
      expect(can(disguised, permission), permission).toEqual({
        allowed: false,
        reason: 'patient_on_staff_route',
      });
    }
  });

  it('keeps its own portal permissions, every one of them', () => {
    expect(PORTAL_ACTOR_PERMISSIONS.length).toBeGreaterThan(5);
    for (const permission of PORTAL_ACTOR_PERMISSIONS) {
      expect(can(patient, permission), permission).toEqual({ allowed: true });
    }
  });

  it('is denied the permission the staff use to run portal accounts, although it starts with portal', () => {
    expect(can(patient, 'portal.manage')).toEqual({
      allowed: false,
      reason: 'patient_on_staff_route',
    });
  });

  it('is denied the new clinical and consent permissions of Stage 5', () => {
    for (const permission of [
      'clinical.prescription.write',
      'clinical.consent.read',
      'consent.template.manage',
      'consent.request',
    ] as const) {
      expect(can(patient, permission).allowed, permission).toBe(false);
    }
  });
});
