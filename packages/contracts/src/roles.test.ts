import { describe, expect, it } from 'vitest';

import {
  GRANTABLE,
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
    expect(GRANTABLE.length).toBe(5);
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
