import type { CalendarEntryDto, Permission } from '@consultorio/contracts';
import type { AnyRoute } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

import { NAV_ITEMS } from './nav/nav-config.js';

/**
 * The registries that let a feature appear in the application without editing a shared file: its
 * routes, its navigation entries and settings tabs, and the pieces it mounts inside screens that
 * other features own (the slots). A feature adds ONE file per registry inside its own folder:
 *
 * - `routes.tsx`: `export default` a list of `FeatureRoute`;
 * - `nav.ts`: `export default` a `NavContribution`;
 * - `slots.tsx`: `export default` a list of `SlotContribution`.
 *
 * The build finds them with `import.meta.glob`; the translations are found the same way (see
 * `i18n.ts`). A feature reaches another feature only through that feature's `index.ts` (lint rule).
 *
 * The routes travel with the first bundle (the router needs every address to answer the first one).
 * The navigation and the slots are only read inside the signed-in frame, so they are a chunk of
 * their own (`registry-contributions.ts`) that the signed-in route waits for with `registry.ready()`:
 * the sign-in page does not pay for them.
 */

// Routes -----------------------------------------------------------------------------------------

/** Where in the route tree a contributed route hangs. */
export type RouteMount =
  /** Inside the signed-in shell (needs a session). */
  | 'authed'
  /** A section of Settings, under `/settings`. */
  | 'settings'
  /** The minimal frame of the public pages (public booking, the waitlist offer). */
  | 'minimal'
  /**
   * The shell of the patient portal (Stage 5): the organization's brand and the portal's name, no
   * staff navigation and no staff session. It is a shell apart from `authed` (the staff `AppShell`)
   * and from `minimal`, so the portal can grow its own frame (the subject picker, the installable
   * scope) without touching either.
   */
  | 'portal'
  /**
   * The platform host (Stage 6): the pages of the product itself that anybody can open before they
   * have an organization, such as the signup. They sit beside the operator console, in a frame of
   * their own, and never on the host of an organization.
   */
  | 'platform';

export interface FeatureRoute {
  mount: RouteMount;
  /** Builds the route under the parent of its mount. */
  create(parent: AnyRoute): AnyRoute;
}

// Navigation -------------------------------------------------------------------------------------

export type NavLayout = 'professional' | 'reception' | 'admin';

export interface NavPlacement {
  layout: NavLayout;
  /** The id of the entry it follows in that layout; the end of the list when missing. */
  after?: string;
}

/** An entry of the sidebar and the bottom bar. */
export interface ContributedNavItem {
  /** Unique, and never one the shell already uses. */
  id: string;
  to: string;
  /** With its namespace: `waitlist:nav.title`. */
  labelKey: string;
  icon: LucideIcon;
  /** The user needs any one of these; empty means everyone signed in. */
  anyOf: readonly Permission[];
  placements: readonly NavPlacement[];
  /**
   * True for an entry that exists only on the multi-tenant platform (the platform subscription): a
   * single-tenant deployment has no signup and no subscription, so it does not list it.
   */
  multiModeOnly?: boolean;
}

/** A section of Settings. */
export interface ContributedSettingsTab {
  id: string;
  to: string;
  /** With its namespace: `messaging:tab.title`. */
  labelKey: string;
  permission: Permission;
}

export interface NavContribution {
  items?: readonly ContributedNavItem[];
  settingsTabs?: readonly ContributedSettingsTab[];
}

// Slots ------------------------------------------------------------------------------------------

export type SettingsArea = 'scheduling';

/** What each slot hands to the pieces mounted in it. */
export interface SlotProps {
  /** The body of the appointment drawer. */
  'appointment-drawer': { appointment: CalendarEntryDto; readOnly: boolean };
  /** A tab of the patient detail page. */
  'patient-detail-tab': { patientId: string };
  /** A small mark beside the status badges in the header of the patient detail page. */
  'patient-header': { patientId: string };
  /** A section inside a settings page. */
  'settings-section': { area: SettingsArea };
  /** Beside an appointment of the professional's day ("Hoy"): quick actions such as joining a call. */
  'today-appointment': { appointment: CalendarEntryDto; readOnly: boolean };
}

export type SlotName = keyof SlotProps;

export interface SlotContribution<S extends SlotName = SlotName> {
  slot: S;
  /** Unique inside the slot. */
  id: string;
  /** Smaller first; 100 when missing. */
  order?: number;
  /** The viewer needs any one of these; missing means everyone who can see the screen. */
  anyOf?: readonly Permission[];
  /** The tab label for `patient-detail-tab` (with its namespace). */
  labelKey?: string;
  Component: ComponentType<SlotProps[S]>;
}

export type AnySlotContribution = { [S in SlotName]: SlotContribution<S> }[SlotName];

const DEFAULT_ORDER = 100;

// Collecting -------------------------------------------------------------------------------------

type Modules<T> = Readonly<Record<string, { default: T }>>;

export function collectRoutes(modules: Modules<readonly FeatureRoute[]>): FeatureRoute[] {
  return Object.values(modules).flatMap((module) => module.default);
}

export interface CollectedNav {
  items: ContributedNavItem[];
  settingsTabs: ContributedSettingsTab[];
}

export function collectNav(modules: Modules<NavContribution>): CollectedNav {
  const items: ContributedNavItem[] = [];
  const settingsTabs: ContributedSettingsTab[] = [];
  for (const { default: contribution } of Object.values(modules)) {
    for (const item of contribution.items ?? []) {
      if (item.id in NAV_ITEMS || items.some((known) => known.id === item.id)) {
        throw new Error(`The navigation entry "${item.id}" is already used.`);
      }
      items.push(item);
    }
    for (const tab of contribution.settingsTabs ?? []) {
      if (settingsTabs.some((known) => known.id === tab.id)) {
        throw new Error(`The settings tab "${tab.id}" is already used.`);
      }
      settingsTabs.push(tab);
    }
  }
  return { items, settingsTabs };
}

/** Every slot contribution, ordered by `order` and then by id. One id per slot. */
export function collectSlots(
  modules: Modules<readonly AnySlotContribution[]>,
): AnySlotContribution[] {
  const slots: AnySlotContribution[] = [];
  for (const { default: contributions } of Object.values(modules)) {
    for (const contribution of contributions) {
      if (slots.some((known) => known.slot === contribution.slot && known.id === contribution.id)) {
        throw new Error(
          `The slot "${contribution.slot}" already has a piece "${contribution.id}".`,
        );
      }
      slots.push(contribution);
    }
  }
  return slots.sort(
    (a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) || a.id.localeCompare(b.id),
  );
}

export interface AppRegistry {
  routes: readonly FeatureRoute[];
  /**
   * The entries of the navigation, the settings tabs and the slot pieces. A registry built from
   * modules has them at once; the one of the application loads them with the signed-in frame, so
   * read them only after `ready()` has resolved (they throw before that: an empty list would hide
   * a screen that forgot to wait).
   */
  navItems: readonly ContributedNavItem[];
  settingsTabs: readonly ContributedSettingsTab[];
  slots: readonly AnySlotContribution[];
  /** Resolves when the navigation and the slots can be read. Safe to call again and again. */
  ready(): Promise<void>;
}

export function createRegistry(sources: {
  routes: Modules<readonly FeatureRoute[]>;
  nav: Modules<NavContribution>;
  slots: Modules<readonly AnySlotContribution[]>;
}): AppRegistry {
  const nav = collectNav(sources.nav);
  return {
    routes: collectRoutes(sources.routes),
    navItems: nav.items,
    settingsTabs: nav.settingsTabs,
    slots: collectSlots(sources.slots),
    ready: () => Promise.resolve(),
  };
}

/** The navigation and slot modules of the features, as `import.meta.glob` gives them. */
export interface ContributionModules {
  nav: Modules<NavContribution>;
  slots: Modules<readonly AnySlotContribution[]>;
}

/**
 * Like `createRegistry`, but the navigation and the slots come from `load`, which runs the first
 * time `ready()` is called. The routes are known at once.
 */
export function createDeferredRegistry(sources: {
  routes: Modules<readonly FeatureRoute[]>;
  load: () => Promise<ContributionModules>;
}): AppRegistry {
  let loaded: Pick<AppRegistry, 'navItems' | 'settingsTabs' | 'slots'> | undefined;
  let loading: Promise<void> | undefined;

  function read() {
    if (!loaded) {
      throw new Error(
        'The navigation and the slots of the features are not loaded yet: wait for registry.ready().',
      );
    }
    return loaded;
  }

  return {
    routes: collectRoutes(sources.routes),
    get navItems() {
      return read().navItems;
    },
    get settingsTabs() {
      return read().settingsTabs;
    },
    get slots() {
      return read().slots;
    },
    ready() {
      loading ??= sources.load().then(({ nav, slots }) => {
        const collected = collectNav(nav);
        loaded = {
          navItems: collected.items,
          settingsTabs: collected.settingsTabs,
          slots: collectSlots(slots),
        };
      });
      // A failed load (the chunk did not arrive) is tried again by the next call, not remembered.
      loading.catch(() => {
        loading = undefined;
      });
      return loading;
    },
  };
}

let registry: AppRegistry | undefined;

/** The registry of the real application: whatever the features contribute at build time. */
export function defaultRegistry(): AppRegistry {
  registry ??= createDeferredRegistry({
    routes: import.meta.glob<{ default: readonly FeatureRoute[] }>('../features/**/routes.tsx', {
      eager: true,
    }),
    load: () => import('./registry-contributions.js'),
  });
  return registry;
}
