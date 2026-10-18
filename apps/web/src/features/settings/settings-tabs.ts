import type { Permission } from '@consultorio/contracts';

import type { ContributedSettingsTab } from '../../app/registry.js';

export type SettingsTabId = 'locations' | 'scheduling' | 'branding' | 'security';

export interface SettingsTab {
  id: string;
  to: string;
  /** Permission that opens the section. */
  permission: Permission;
  /** With its namespace, for a section a feature contributes; the built-in ones use `settings:tab.<id>`. */
  labelKey: string;
}

const builtIn = (id: SettingsTabId, permission: Permission): SettingsTab => ({
  id,
  to: `/settings/${id}`,
  permission,
  labelKey: `settings:tab.${id}`,
});

/** The sections of Settings, in the order they are offered. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  builtIn('locations', 'locations.manage'),
  builtIn('scheduling', 'scheduling.configure'),
  builtIn('branding', 'tenant.branding.manage'),
  builtIn('security', 'tenant.settings.manage'),
];

/** Every section: the built-in ones, then the ones features contribute through `nav.ts`. */
export function allSettingsTabs(
  contributed: readonly ContributedSettingsTab[] = [],
): readonly SettingsTab[] {
  return [...SETTINGS_TABS, ...contributed];
}

/** The sections this person may open. */
export function settingsTabsFor(
  permissions: readonly Permission[],
  contributed: readonly ContributedSettingsTab[] = [],
): SettingsTab[] {
  return allSettingsTabs(contributed).filter((tab) => permissions.includes(tab.permission));
}
