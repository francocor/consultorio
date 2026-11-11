import { describe, expect, it } from 'vitest';

import {
  GRANTABLE,
  canChangeRoles,
  canGrantRoles,
  canManageRoles,
  rolesInviterMayGrant,
  PERMISSIONS,
  PORTAL_ACTOR_PERMISSIONS,
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

describe('owner and admin bring professionals in (decision D19, revised 2026-10-17)', () => {
  it('lets an owner hand out every staff role', () => {
    expect([...rolesInviterMayGrant(['owner'])].sort()).toEqual(
      ['admin', 'owner', 'professional', 'reception'].sort(),
    );
  });

  it('lets an admin hand out admin, professional and reception, but never the owner role', () => {
    expect([...rolesInviterMayGrant(['admin'])].sort()).toEqual(
      ['admin', 'professional', 'reception'].sort(),
    );
    expect(canGrantRoles(['admin'], ['professional'])).toBe(true);
    expect(canGrantRoles(['admin'], ['reception', 'professional'])).toBe(true);
    expect(canGrantRoles(['admin'], ['reception'])).toBe(true);
    expect(canGrantRoles(['admin'], ['owner'])).toBe(false);
    expect(canGrantRoles(['admin'], ['reception', 'owner'])).toBe(false);
  });

  it('gives reception and professionals nothing to hand out', () => {
    expect(canGrantRoles(['reception'], ['professional'])).toBe(false);
    expect(canGrantRoles(['professional'], ['professional'])).toBe(false);
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

  it('lets an admin add the professional role to a member, or keep it', () => {
    expect(canChangeRoles(['admin'], ['professional'], ['professional', 'admin'])).toBe(true);
    expect(canChangeRoles(['admin'], ['professional'], ['reception'])).toBe(true);
    expect(canChangeRoles(['admin'], ['reception'], ['reception', 'professional'])).toBe(true);
    expect(canChangeRoles(['admin'], ['reception'], ['professional'])).toBe(true);
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

describe('Stage 4 permissions (revenue)', () => {
  const holders = (permission: Permission) =>
    ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));

  it.each([
    'pricing.manage',
    'charges.void',
    'payments.refund',
    'invoicing.configure',
    'invoicing.credit_note',
    'invoicing.manual',
  ] as const)('keeps %s with the owner and the admin', (permission) => {
    expect(holders(permission)).toEqual(['owner', 'admin']);
  });

  it('lets reception issue an invoice, as the owner and the admin do', () => {
    expect(holders('invoicing.issue')).toEqual(['owner', 'admin', 'reception']);
  });

  it('keeps every sensitive money action away from reception and the professionals', () => {
    for (const role of ['reception', 'professional'] as const) {
      for (const permission of [
        'charges.void',
        'payments.refund',
        'pricing.manage',
        'invoicing.credit_note',
        'invoicing.manual',
        'invoicing.configure',
      ] as const) {
        expect(ROLE_PERMISSIONS[role], `${role} -> ${permission}`).not.toContain(permission);
      }
    }
  });

  it('keeps the owner-only platform subscription permission out of the money bundle', () => {
    expect(holders('billing.manage')).toEqual(['owner']);
  });

  it('adds none of them to the grantable list or to the clinical group', () => {
    for (const permission of [
      'pricing.manage',
      'charges.void',
      'payments.refund',
      'invoicing.issue',
      'invoicing.configure',
      'invoicing.credit_note',
      'invoicing.manual',
    ] as const) {
      expect(GRANTABLE).not.toContain(permission);
      expect(isClinicalPermission(permission)).toBe(false);
    }
    expect(GRANTABLE.length).toBe(7);
  });

  it('gives reports to the roles the spec scopes on the server: professional (own) and reception', () => {
    expect(holders('reports.read')).toEqual(['owner', 'admin', 'professional', 'reception']);
    expect(ROLE_PERMISSIONS.patient).not.toContain('reports.read');
  });
});

describe('Stage 5 permissions (compliance and portal)', () => {
  const holders = (permission: Permission) =>
    ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));

  it.each(['clinical.prescription.write', 'clinical.consent.read'] as const)(
    'keeps %s with the professional only, and out of the grantable list',
    (permission) => {
      expect(isClinicalPermission(permission)).toBe(true);
      expect(holders(permission)).toEqual(['professional']);
      expect(GRANTABLE).not.toContain(permission);
    },
  );

  it('still finds no clinical permission outside the professional role once Stage 5 is in', () => {
    expect(findClinicalLeaks(ROLE_PERMISSIONS, GRANTABLE)).toEqual([]);
    for (const role of ROLES.filter((known) => known !== 'professional')) {
      expect(ROLE_PERMISSIONS[role].filter(isClinicalPermission), role).toEqual([]);
    }
    // An owner who is also a professional holds them through the professional role only.
    expect(effectivePermissions(['owner'], ['clinical.prescription.write'])).not.toContain(
      'clinical.prescription.write',
    );
  });

  it('lets the owner, the admin and the professional manage consent templates', () => {
    expect(holders('consent.template.manage')).toEqual(['owner', 'admin', 'professional']);
  });

  it('lets a professional and reception request a consent, and nobody else', () => {
    expect(holders('consent.request')).toEqual(['professional', 'reception']);
  });

  it('lets the owner, the admin and reception invite, link and deactivate portal accounts', () => {
    expect(holders('portal.manage')).toEqual(['owner', 'admin', 'reception']);
  });

  it('keeps changing the email of a portal account from reception: only the owner and the admin (JD-S5 R1-A-C1)', () => {
    expect(holders('portal.identity.email')).toEqual(['owner', 'admin']);
  });
  it.each([
    'portal.consent.sign',
    'portal.consent.revoke',
    'portal.document.read',
    'portal.prescription.read',
    'portal.invoice.read',
    'portal.profile.write',
  ] as const)('gives the portal actor %s and no staff role', (permission) => {
    expect(holders(permission)).toEqual(['patient']);
  });

  it('lists exactly what the portal actor may hold, and none of it is staff administration', () => {
    expect([...PORTAL_ACTOR_PERMISSIONS].sort()).toEqual(
      [
        'portal.appointment.cancel',
        'portal.consent.revoke',
        'portal.consent.sign',
        'portal.document.read',
        'portal.invoice.read',
        'portal.prescription.read',
        'portal.profile.write',
        'portal.self.read',
      ].sort(),
    );
    expect(PORTAL_ACTOR_PERMISSIONS).not.toContain('portal.manage');
    expect(PORTAL_ACTOR_PERMISSIONS).not.toContain('portal.identity.email');
    expect(PORTAL_ACTOR_PERMISSIONS.filter(isClinicalPermission)).toEqual([]);
  });

  it('adds none of the new permissions to the grantable list', () => {
    for (const permission of [
      'consent.template.manage',
      'consent.request',
      'portal.manage',
      'portal.identity.email',
    ] as const) {
      expect(GRANTABLE).not.toContain(permission);
      expect(isClinicalPermission(permission)).toBe(false);
    }
    expect(GRANTABLE.length).toBe(7);
  });
});

describe('Stage 6 permissions (subscriptions, signup, cancellation)', () => {
  const holders = (permission: Permission) =>
    ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));

  // Stage 6 adds no tenant permission: `billing.manage` already exists and guards every subscription
  // route; signup is public; the cancellation export is the owner's and each professional's own.
  it('keeps the subscription in the hands of the owner alone, as the one permission of the stage', () => {
    expect(holders('billing.manage')).toEqual(['owner']);
    for (const role of ['admin', 'professional', 'reception', 'patient'] as const) {
      expect(ROLE_PERMISSIONS[role], role).not.toContain('billing.manage');
    }
  });

  it('never lets a grant, the clinical group or the portal reach it', () => {
    expect(GRANTABLE).not.toContain('billing.manage');
    expect(isClinicalPermission('billing.manage')).toBe(false);
    expect(PORTAL_ACTOR_PERMISSIONS).not.toContain('billing.manage');
    // A grant of it to reception or admin changes nothing.
    expect(effectivePermissions(['admin'], ['billing.manage'])).not.toContain('billing.manage');
    expect(effectivePermissions(['reception'], ['billing.manage'])).not.toContain('billing.manage');
  });

  it('adds no permission for signup, subscriptions, the export or the archive', () => {
    const names = PERMISSIONS.filter((permission) =>
      /^(signup|subscription|archive|cancellation|export)\./.test(permission),
    );

    expect(names).toEqual([]);
  });
});
