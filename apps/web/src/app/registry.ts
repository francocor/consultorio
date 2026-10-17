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
 */

// Routes -----------------------------------------------------------------------------------------

/** Where in the route tree a contributed route hangs. */
export type RouteMount =
  /** Inside the signed-in shell (needs a session). */
  | 'authed'
  /** A section of Settings, under `/settings`. */
  | 'settings'
  /** The minimal frame of the public pages and the patient portal. */
  | 'minimal';

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
  /** A section inside a settings page. */
  'settings-section': { area: SettingsArea };
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
  navItems: readonly ContributedNavItem[];
  settingsTabs: readonly ContributedSettingsTab[];
  slots: readonly AnySlotContribution[];
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
  };
}

let registry: AppRegistry | undefined;

/** The registry of the real application: whatever the features contribute at build time. */
export function defaultRegistry(): AppRegistry {
  registry ??= createRegistry({
    routes: import.meta.glob<{ default: readonly FeatureRoute[] }>('../features/**/routes.tsx', {
      eager: true,
    }),
    nav: import.meta.glob<{ default: NavContribution }>('../features/**/nav.ts', { eager: true }),
    slots: import.meta.glob<{ default: readonly AnySlotContribution[] }>(
      '../features/**/slots.tsx',
      { eager: true },
    ),
  });
  return registry;
}
