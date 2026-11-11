import { effectivePermissions, ROLE_PERMISSIONS, type Role } from '@consultorio/contracts';
import { Users } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { collectNav, type ContributedNavItem } from '../registry.js';

import { buildNav, splitForMobile, ENABLED_STAGE, NAV_ITEMS } from './nav-config.js';

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

  it('a professional sees today, the agenda, patients and prescriptions until the clinical drafts are built', () => {
    expect(idsFor(['professional'])).toEqual([
      'home',
      'today',
      'calendar',
      'patients',
      'prescriptions',
    ]);
  });

  it('only whoever may read prescriptions sees the entry', () => {
    for (const roles of [['reception'], ['owner'], ['admin'], ['patient']] as const) {
      expect(idsFor(roles), roles.join()).not.toContain('prescriptions');
    }
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
      'prescriptions',
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

  it('a grant adds a permission, not an entry: the revenue screens come from their own features', () => {
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

  it('reception layout: calendar, check-in, worklist, patients (cash and reports are contributed)', () => {
    expect(idsFor(['reception'], 6)).toEqual([
      'home',
      'calendar',
      'check-in',
      'worklist',
      'patients',
    ]);
  });

  it('owner and admin share one layout: the subscription is contributed by its feature, not reserved by the shell', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(idsFor([role], 6), role).toEqual([
        'home',
        'calendar',
        'worklist',
        'patients',
        'staff',
        'audit',
        'settings',
      ]);
    }
    expect(Object.keys(NAV_ITEMS)).not.toContain('billing');
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
        'calendar',
        'check-in',
        'drafts',
        'home',
        'patients',
        'prescriptions',
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

describe('entries that features contribute (nav.ts)', () => {
  const entry = (
    id: string,
    placements: ContributedNavItem['placements'],
    anyOf: ContributedNavItem['anyOf'] = ['waitlist.manage'],
  ): ContributedNavItem => ({
    id,
    to: `/${id}`,
    labelKey: `${id}:nav.title`,
    icon: Users,
    anyOf,
    placements,
  });
  const idsWith = (roles: readonly Role[], contributed: readonly ContributedNavItem[]) =>
    buildNav({ permissions: effectivePermissions(roles, []), roles, contributed }).map(
      (item) => item.id,
    );

  it('places an entry after the one it names, in the layouts that ask for it', () => {
    const waitlist = entry('waitlist', [
      { layout: 'reception', after: 'worklist' },
      { layout: 'admin', after: 'calendar' },
    ]);

    expect(idsWith(['reception'], [waitlist])).toEqual([
      'home',
      'calendar',
      'check-in',
      'worklist',
      'waitlist',
      'patients',
    ]);
    expect(idsWith(['admin'], [waitlist]).slice(0, 3)).toEqual(['home', 'calendar', 'waitlist']);
  });

  it('puts it at the end of the layout when it names nobody, or somebody that is not there', () => {
    expect(idsWith(['reception'], [entry('a', [{ layout: 'reception' }])]).at(-1)).toBe('a');
    expect(
      idsWith(['reception'], [entry('b', [{ layout: 'reception', after: 'ghost' }])]).at(-1),
    ).toBe('b');
  });

  it('leaves it out for a role whose layout does not place it, and for a user without the permission', () => {
    const waitlist = entry('waitlist', [{ layout: 'reception' }]);

    expect(idsWith(['professional'], [waitlist])).not.toContain('waitlist');
    expect(
      idsWith(['reception'], [entry('links', [{ layout: 'reception' }], ['booking.manage'])]),
    ).not.toContain('links');
  });

  it('shows it once when two roles of the user place it', () => {
    const waitlist = entry('waitlist', [{ layout: 'reception' }, { layout: 'professional' }]);

    const ids = idsWith(['reception', 'professional'], [waitlist]);

    expect(ids.filter((id) => id === 'waitlist')).toHaveLength(1);
  });

  it('carries the namespace of the feature in the label key and leaves the shell entries as they were', () => {
    const items = buildNav({
      permissions: effectivePermissions(['reception'], []),
      roles: ['reception'],
      contributed: [entry('waitlist', [{ layout: 'reception' }])],
    });

    expect(items.find((item) => item.id === 'waitlist')?.labelKey).toBe('waitlist:nav.title');
    expect(items.find((item) => item.id === 'calendar')?.labelKey).toBe('nav.calendar');
  });
});

describe('the revenue screens (Stage 4) contribute their own entries', () => {
  // The placements `docs/stage4-tracks.md` gives the tracks, in the order the build finds the
  // `nav.ts` files (by path: billing, cash, invoicing, reports).
  const entry = (
    id: string,
    anyOf: ContributedNavItem['anyOf'],
    placements: ContributedNavItem['placements'],
  ): ContributedNavItem => ({
    id,
    to: `/${id}`,
    labelKey: `${id}:nav`,
    icon: Users,
    anyOf,
    placements,
  });
  const revenue = [
    entry(
      'charges',
      ['payments.read'],
      [
        { layout: 'reception', after: 'check-in' },
        { layout: 'admin', after: 'patients' },
        { layout: 'professional' },
      ],
    ),
    entry('cash', ['cash.operate'], [{ layout: 'reception', after: 'patients' }]),
    entry(
      'invoices',
      ['invoicing.issue'],
      [{ layout: 'reception' }, { layout: 'admin', after: 'charges' }],
    ),
    entry(
      'reports',
      ['reports.read'],
      [{ layout: 'admin', after: 'staff' }, { layout: 'reception' }, { layout: 'professional' }],
    ),
  ];
  const idsFor4 = (roles: readonly Role[]) =>
    buildNav({
      permissions: effectivePermissions(roles, []),
      roles,
      contributed: revenue,
    }).map((item) => item.id);

  it('frees the ids of the cash register and the reports, which the shell used to hold', () => {
    const everything = buildNav({
      permissions: effectivePermissions(['owner', 'reception', 'professional'], []),
      roles: ['owner', 'reception', 'professional'],
      stage: 6,
    }).map((item) => item.id);

    expect(everything).not.toContain('cash');
    expect(everything).not.toContain('reports');
    expect(() => collectNav({ a: { default: { items: revenue } } })).not.toThrow();
  });

  it('reception: charges after check-in, then the cash register, the invoices and the reports', () => {
    expect(idsFor4(['reception'])).toEqual([
      'home',
      'calendar',
      'check-in',
      'charges',
      'worklist',
      'patients',
      'cash',
      'invoices',
      'reports',
    ]);
  });

  it('a professional sees the charges and reports of their own appointments, and no cash or invoices', () => {
    expect(idsFor4(['professional'])).toEqual([
      'home',
      'today',
      'calendar',
      'patients',
      'prescriptions',
      'charges',
      'reports',
    ]);
  });

  it('owner and admin see charges, invoices and reports, and no cash register of their own', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(idsFor4([role]), role).toEqual([
        'home',
        'calendar',
        'worklist',
        'patients',
        'charges',
        'invoices',
        'staff',
        'reports',
        'audit',
        'settings',
      ]);
    }
  });

  it('a patient sees none of it', () => {
    expect(idsFor4(['patient'])).toEqual(['home']);
  });
});

describe('entries that exist only on the multi-tenant platform', () => {
  const subscription: ContributedNavItem = {
    id: 'subscription',
    to: '/subscription',
    labelKey: 'subscription:nav',
    icon: Users,
    anyOf: ['billing.manage'],
    multiModeOnly: true,
    placements: [{ layout: 'admin', after: 'staff' }],
  };
  const idsIn = (deploymentMode: 'multi' | 'single' | undefined) =>
    buildNav({
      permissions: effectivePermissions(['owner'], []),
      roles: ['owner'],
      contributed: [subscription],
      deploymentMode,
    }).map((item) => item.id);

  it('lists it for the owner of a multi-tenant platform, after the team', () => {
    expect(idsIn('multi')).toContain('subscription');
    const ids = idsIn('multi');
    expect(ids.indexOf('subscription')).toBe(ids.indexOf('staff') + 1);
  });

  it('leaves it out of a single-tenant deployment, which has no subscription', () => {
    expect(idsIn('single')).not.toContain('subscription');
    // The rest of the layout is the same.
    expect(idsIn('single')).toEqual(idsIn('multi').filter((id) => id !== 'subscription'));
  });

  it('keeps it out while the deployment is still unknown, so a single-tenant owner never sees a dead link appear', () => {
    expect(idsIn(undefined)).not.toContain('subscription');
  });

  it('never hides an entry that does not say so, in either mode', () => {
    const plain: ContributedNavItem = { ...subscription, id: 'export', multiModeOnly: false };
    const ids = buildNav({
      permissions: effectivePermissions(['owner'], []),
      roles: ['owner'],
      contributed: [plain],
      deploymentMode: 'single',
    }).map((item) => item.id);

    expect(ids).toContain('export');
  });
});
