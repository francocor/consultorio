import { describe, expect, it } from 'vitest';

import {
  GRANTABLE,
  canChangeRoles,
  canGrantRoles,
  canManageRoles,
  rolesInviterMayGrant,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  effectivePermissions,
  findClinicalLeaks,
  isClinicalPermission,
  type Permission,
  type Role,
} from './roles.js';

const NON_PROFESSIONAL_ROLES = ROLES.filter((role) => role !== 'professional');

describe('role catalog', () => {
  it('defines the fixed role set', () => {
    expect([...ROLES]).toEqual(['owner', 'admin', 'professional', 'reception', 'patient']);
  });

  it('gives every role a permission list made only of catalogued permissions', () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role].length, role).toBeGreaterThan(0);
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS, `${role} -> ${permission}`).toContain(permission);
      }
    }
  });
});

describe('clinical permissions are locked to the professional role (hard rule)', () => {
  it('no non-professional role holds any clinical.* permission', () => {
    for (const role of NON_PROFESSIONAL_ROLES) {
      const clinical = ROLE_PERMISSIONS[role].filter(isClinicalPermission);
      expect(clinical, role).toEqual([]);
    }
  });

  it('owner and admin hold no clinical permission, even combined', () => {
    const combined = effectivePermissions(['owner', 'admin'], []);

    expect(combined.length).toBeGreaterThan(0);
    expect(combined.filter(isClinicalPermission)).toEqual([]);
  });

  it('the grantable list contains no clinical.* permission', () => {
    expect(GRANTABLE.length).toBe(7);
    expect(GRANTABLE.filter(isClinicalPermission)).toEqual([]);
  });

  it('the professional role does hold the clinical permissions', () => {
    const clinical = ROLE_PERMISSIONS.professional.filter(isClinicalPermission);

    expect(clinical).toEqual(
      expect.arrayContaining([
        'clinical.note.read',
        'clinical.note.write',
        'clinical.note.sign',
        'clinical.addendum.create',
      ]),
    );
  });

  it('findClinicalLeaks reports a catalog that gained a clinical permission (the guard proves itself)', () => {
    const corrupted: Record<Role, readonly Permission[]> = {
      ...ROLE_PERMISSIONS,
      reception: [...ROLE_PERMISSIONS.reception, 'clinical.note.read'],
    };

    expect(findClinicalLeaks(corrupted, GRANTABLE)).toEqual([
      { where: 'role:reception', permission: 'clinical.note.read' },
    ]);
    expect(findClinicalLeaks(corrupted, [...GRANTABLE, 'clinical.note.write'])).toEqual([
      { where: 'role:reception', permission: 'clinical.note.read' },
      { where: 'grantable', permission: 'clinical.note.write' },
    ]);
    expect(findClinicalLeaks(ROLE_PERMISSIONS, GRANTABLE)).toEqual([]);
  });
});

describe('effective permissions = role permissions + (grants inside GRANTABLE)', () => {
  it('adds a grantable permission a role does not hold', () => {
    const base = effectivePermissions(['professional'], []);
    const granted = effectivePermissions(['professional'], ['cash.operate']);

    expect(base).not.toContain('cash.operate');
    expect(granted).toContain('cash.operate');
  });

  it('ignores a grant that is not grantable, such as a clinical permission', () => {
    const result = effectivePermissions(['reception'], ['clinical.note.read', 'billing.manage']);

    expect(result).not.toContain('clinical.note.read');
    expect(result).not.toContain('billing.manage');
  });

  it('does not duplicate a permission the role already holds', () => {
    const result = effectivePermissions(['reception'], ['cash.operate']);

    expect(result.filter((permission) => permission === 'cash.operate')).toHaveLength(1);
  });

  it('keeps booking over a slot hold behind an explicit grant, held by owner and admin by default', () => {
    expect(GRANTABLE).toContain('scheduling.override_hold');
    expect(effectivePermissions(['owner'], [])).toContain('scheduling.override_hold');
    expect(effectivePermissions(['admin'], [])).toContain('scheduling.override_hold');
    expect(effectivePermissions(['reception'], [])).not.toContain('scheduling.override_hold');
    expect(effectivePermissions(['professional'], [])).not.toContain('scheduling.override_hold');
    expect(effectivePermissions(['reception'], ['scheduling.override_hold'])).toContain(
      'scheduling.override_hold',
    );
  });

  it('gives reception patient administration and the cash register by default', () => {
    expect(ROLE_PERMISSIONS.reception).toEqual(
      expect.arrayContaining(['patients.administer', 'cash.operate']),
    );
    expect(ROLE_PERMISSIONS.professional).not.toContain('cash.operate');
  });

  it('keeps the patient role away from every staff permission', () => {
    expect(ROLE_PERMISSIONS.patient.every((permission) => permission.startsWith('portal.'))).toBe(
      true,
    );
  });
});

describe('only the owner brings professionals in (decision D19)', () => {
  it('lets an owner hand out every staff role', () => {
    expect([...rolesInviterMayGrant(['owner'])].sort()).toEqual(
      ['admin', 'owner', 'professional', 'reception'].sort(),
    );
  });

  it('keeps the professional role out of an admin ceiling, and the owner role too', () => {
    expect([...rolesInviterMayGrant(['admin'])].sort()).toEqual(['admin', 'reception']);
    expect(canGrantRoles(['admin'], ['professional'])).toBe(false);
    expect(canGrantRoles(['admin'], ['reception', 'professional'])).toBe(false);
    expect(canGrantRoles(['admin'], ['reception'])).toBe(true);
  });

  it('does not let an admin who also holds the professional role grant the professional role', () => {
    expect(canGrantRoles(['admin', 'professional'], ['professional'])).toBe(false);
  });

  it('still lets an admin manage the people who are already professionals', () => {
    expect(canManageRoles(['admin'], ['professional'])).toBe(true);
    expect(canManageRoles(['admin'], ['professional', 'reception'])).toBe(true);
    expect(canManageRoles(['admin'], ['owner'])).toBe(false);
    expect(canManageRoles(['admin'], ['owner', 'professional'])).toBe(false);
    expect(canManageRoles(['owner'], ['owner'])).toBe(true);
    expect(canManageRoles(['reception'], ['reception'])).toBe(false);
    expect(canManageRoles(['owner'], [])).toBe(false);
  });

  it('lets an admin keep a professional role the member already has, but not add it', () => {
    expect(canChangeRoles(['admin'], ['professional'], ['professional', 'admin'])).toBe(true);
    expect(canChangeRoles(['admin'], ['professional'], ['reception'])).toBe(true);
    expect(canChangeRoles(['admin'], ['reception'], ['reception', 'professional'])).toBe(false);
    expect(canChangeRoles(['admin'], ['reception'], ['professional'])).toBe(false);
    expect(canChangeRoles(['owner'], ['reception'], ['professional'])).toBe(true);
  });

  it('never lets an admin touch an owner or hand out the owner role', () => {
    expect(canChangeRoles(['admin'], ['owner'], ['reception'])).toBe(false);
    expect(canChangeRoles(['admin'], ['reception'], ['owner'])).toBe(false);
  });

  it('refuses an empty set of roles', () => {
    expect(canChangeRoles(['owner'], ['reception'], [])).toBe(false);
  });
});

describe('Stage 3 permissions (patient engagement)', () => {
  const holders = (permission: Permission) =>
    ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));

  it('gives messaging settings to owner and admin, and the message log also to reception', () => {
    expect(holders('notifications.manage')).toEqual(['owner', 'admin']);
    expect(holders('notifications.log.read')).toEqual(['owner', 'admin', 'reception']);
  });

  it('gives online booking links to owner and admin only', () => {
    expect(holders('booking.manage')).toEqual(['owner', 'admin']);
  });

  it('lets the front desk and the professionals run the waitlist, but nobody else', () => {
    expect(holders('waitlist.manage')).toEqual(['owner', 'admin', 'professional', 'reception']);
  });

  it('lets only professionals join a video consultation as a participant', () => {
    expect(holders('teleconsultation.join')).toEqual(['professional']);
  });

  it('adds none of them to the grantable list or to the clinical group', () => {
    for (const permission of [
      'notifications.manage',
      'notifications.log.read',
      'booking.manage',
      'waitlist.manage',
      'teleconsultation.join',
    ] as const) {
      expect(GRANTABLE).not.toContain(permission);
      expect(isClinicalPermission(permission)).toBe(false);
    }
    expect(GRANTABLE.length).toBe(7);
  });
});
