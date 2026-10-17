import { Users } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import {
  collectNav,
  collectRoutes,
  collectSlots,
  createRegistry,
  defaultRegistry,
  type FeatureRoute,
  type NavContribution,
  type SlotContribution,
} from './registry.js';

const route = (mount: FeatureRoute['mount'], label: string): FeatureRoute => ({
  mount,
  create: () => ({ label }) as never,
});

const nav = (id: string, extra: Partial<NavContribution> = {}): { default: NavContribution } => ({
  default: {
    items: [
      {
        id,
        to: `/${id}`,
        labelKey: `${id}:nav.title`,
        icon: Users,
        anyOf: ['patients.read'],
        placements: [{ layout: 'reception' }],
      },
    ],
    ...extra,
  },
});

describe('collecting the routes that features contribute', () => {
  it('takes the routes of every routes.tsx, in the order of the files', () => {
    const routes = collectRoutes({
      '../features/alpha/routes.tsx': { default: [route('authed', 'alpha')] },
      '../features/beta/routes.tsx': {
        default: [route('settings', 'beta'), route('minimal', 'b2')],
      },
    });

    expect(routes.map((entry) => entry.mount)).toEqual(['authed', 'settings', 'minimal']);
  });

  it('asks a contribution to create its route under the parent it is given', () => {
    const create = vi.fn(() => ({}) as never);
    const [entry] = collectRoutes({
      '../features/alpha/routes.tsx': { default: [{ mount: 'authed', create }] },
    });
    const parent = { id: 'authed' } as never;

    entry?.create(parent);

    expect(create).toHaveBeenCalledWith(parent);
  });

  it('is empty when no feature contributes one', () => {
    expect(collectRoutes({})).toEqual([]);
  });
});

describe('collecting the navigation that features contribute', () => {
  it('joins the entries and the settings tabs of every nav.ts', () => {
    const joined = collectNav({
      '../features/alpha/nav.ts': nav('alpha'),
      '../features/beta/nav.ts': {
        default: {
          settingsTabs: [
            {
              id: 'messaging',
              to: '/settings/messaging',
              labelKey: 'messaging:tab.title',
              permission: 'notifications.manage',
            },
          ],
        },
      },
    });

    expect(joined.items.map((item) => item.id)).toEqual(['alpha']);
    expect(joined.settingsTabs.map((tab) => tab.id)).toEqual(['messaging']);
  });

  it('refuses two entries with the same id, and two settings tabs with the same id', () => {
    expect(() =>
      collectNav({ '../features/a/nav.ts': nav('same'), '../features/b/nav.ts': nav('same') }),
    ).toThrow(/same/);
    const tab = {
      id: 'dup',
      to: '/settings/dup',
      labelKey: 'x:y',
      permission: 'notifications.manage' as const,
    };
    expect(() =>
      collectNav({
        '../features/a/nav.ts': { default: { settingsTabs: [tab] } },
        '../features/b/nav.ts': { default: { settingsTabs: [tab] } },
      }),
    ).toThrow(/dup/);
  });

  it('refuses an entry whose id is one the shell already uses', () => {
    expect(() => collectNav({ '../features/a/nav.ts': nav('calendar') })).toThrow(/calendar/);
  });
});

describe('collecting the slot contributions that features add', () => {
  const Dummy = () => null;
  const contribution = (id: string, order?: number): SlotContribution<'appointment-drawer'> => ({
    slot: 'appointment-drawer',
    id,
    ...(order === undefined ? {} : { order }),
    Component: Dummy,
  });

  it('orders them by the order they ask for, then by id, per slot', () => {
    const slots = collectSlots({
      '../features/a/slots.tsx': { default: [contribution('late', 20), contribution('b')] },
      '../features/b/slots.tsx': { default: [contribution('a'), contribution('first', 1)] },
    });

    expect(slots.map((entry) => entry.id)).toEqual(['first', 'late', 'a', 'b']);
  });

  it('refuses two contributions with the same id in one slot', () => {
    expect(() =>
      collectSlots({
        '../features/a/slots.tsx': { default: [contribution('same')] },
        '../features/b/slots.tsx': { default: [contribution('same')] },
      }),
    ).toThrow(/same/);
  });

  it('allows the same id in two different slots', () => {
    const other: SlotContribution<'settings-section'> = {
      slot: 'settings-section',
      id: 'same',
      Component: Dummy,
    };

    expect(
      collectSlots({
        '../features/a/slots.tsx': { default: [contribution('same'), other] },
      }),
    ).toHaveLength(2);
  });
});

describe('the registry of the application', () => {
  it('is built from fixture features like from the real ones', () => {
    const registry = createRegistry({
      routes: { '../features/a/routes.tsx': { default: [route('authed', 'a')] } },
      nav: { '../features/a/nav.ts': nav('alpha') },
      slots: {},
    });

    expect(registry.routes).toHaveLength(1);
    expect(registry.navItems.map((item) => item.id)).toEqual(['alpha']);
    expect(registry.slots).toEqual([]);
  });

  it('finds the routes.tsx files of the features through the glob: the public booking page is one', () => {
    const mounts = defaultRegistry().routes.map((entry) => entry.mount);

    expect(mounts).toContain('minimal');
  });
});
