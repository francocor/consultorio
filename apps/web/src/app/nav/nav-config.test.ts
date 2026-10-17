import { effectivePermissions, ROLE_PERMISSIONS, type Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildNav, splitForMobile, ENABLED_STAGE } from './nav-config.js';

const idsFor = (roles: readonly Role[], stage = ENABLED_STAGE, grants: string[] = []) =>
  buildNav({ permissions: effectivePermissions(roles, grants), roles, stage }).map(
    (item) => item.id,
  );

describe('navigation at the stage that ships (Stage 2, screens built so far)', () => {
  it('ships Stage 2', () => {
    expect(ENABLED_STAGE).toBe(2);
  });

  it('reception sees the agenda and patients, and no clinical entry point', () => {
    const ids = idsFor(['reception']);

    expect(ids).toEqual(['home', 'calendar', 'check-in', 'worklist', 'patients']);
    expect(ids).not.toContain('drafts');
    expect(ids).not.toContain('prescriptions');
  });

  it('a professional sees today, the agenda and patients until the clinical screens are built', () => {
    expect(idsFor(['professional'])).toEqual(['home', 'today', 'calendar', 'patients']);
  });

  it('owner and admin see the agenda, settings, staff and audit, and still no clinical entry point', () => {
    for (const role of ['owner', 'admin'] as const) {
      const ids = idsFor([role]);

      expect(ids, role).toEqual([
        'home',
        'calendar',
        'worklist',
        'patients',
        'staff',
        'audit',
        'settings',
      ]);
      expect(ids).not.toContain('drafts');
    }
  });

  it('an owner who is also a professional gets both areas once, clinical ones governed by the professional role', () => {
    const ids = idsFor(['owner', 'professional']);

    expect(ids).toEqual([
      'home',
      'today',
      'calendar',
      'patients',
      'worklist',
      'staff',
      'audit',
      'settings',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a patient (portal role) gets no staff navigation', () => {
    expect(idsFor(['patient'])).toEqual(['home']);
  });

  it('a grant adds nothing that needs a different permission (cash needs its stage)', () => {
    expect(idsFor(['reception'], ENABLED_STAGE, ['cash.operate'])).toEqual([
      'home',
      'calendar',
      'check-in',
      'worklist',
      'patients',
    ]);
  });
});

describe('navigation once every stage has shipped', () => {
  it('professional layout: today, agenda, patients, drafts, prescriptions', () => {
    expect(idsFor(['professional'], 6)).toEqual([
      'home',
      'today',
      'calendar',
      'patients',
      'drafts',
      'prescriptions',
    ]);
  });

  it('reception layout: calendar, check-in, worklist, patients, cash', () => {
    expect(idsFor(['reception'], 6)).toEqual([
      'home',
      'calendar',
      'check-in',
      'worklist',
      'patients',
      'cash',
    ]);
  });

  it('owner layout adds reports and billing, billing only for the owner', () => {
    expect(idsFor(['owner'], 6)).toEqual([
      'home',
      'calendar',
      'worklist',
      'patients',
      'staff',
      'reports',
      'billing',
      'audit',
      'settings',
    ]);
    expect(idsFor(['admin'], 6)).not.toContain('billing');
  });

  it('a multi-role user combines the layouts, professional first', () => {
    const ids = idsFor(['owner', 'professional'], 6);

    expect(ids.slice(0, 4)).toEqual(['home', 'today', 'calendar', 'patients']);
    expect(ids).toContain('staff');
    expect(ids).toContain('prescriptions');
  });
});

describe('every entry names a permission the role catalog really has', () => {
  it('has no item guarded by a permission that does not exist', () => {
    const everything = new Set(Object.values(ROLE_PERMISSIONS).flat());
    const allRoles: Role[] = ['owner', 'admin', 'professional', 'reception', 'patient'];
    const shown = new Set(allRoles.flatMap((role) => idsFor([role], 6)));

    // Every item that is part of a layout shows for at least one role: none is dead config.
    expect([...shown].sort()).toEqual(
      [
        'audit',
        'billing',
        'calendar',
        'cash',
        'check-in',
        'drafts',
        'home',
        'patients',
        'prescriptions',
        'reports',
        'settings',
        'staff',
        'today',
        'worklist',
      ].sort(),
    );
    expect(everything.has('staff.manage')).toBe(true);
  });
});

describe('splitForMobile', () => {
  const item = (id: string) => ({ id }) as never;

  it('keeps up to five entries in the bottom bar', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map(item);

    expect(splitForMobile(five).primary).toHaveLength(5);
    expect(splitForMobile(five).more).toEqual([]);
  });

  it('with more than five, shows four and puts the rest under "More"', () => {
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(item);

    const { primary, more } = splitForMobile(seven);

    expect(primary).toHaveLength(4);
    expect(more).toHaveLength(3);
    expect(primary.map((entry) => (entry as { id: string }).id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
