import type { Permission } from '@consultorio/contracts';

export type SettingsTabId = 'locations' | 'branding' | 'security';

export interface SettingsTab {
  id: SettingsTabId;
  to: `/settings/${SettingsTabId}`;
  /** Permission that opens the section. */
  permission: Permission;
}

/** The sections of Settings, in the order they are offered. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  { id: 'locations', to: '/settings/locations', permission: 'locations.manage' },
  { id: 'branding', to: '/settings/branding', permission: 'tenant.branding.manage' },
  { id: 'security', to: '/settings/security', permission: 'tenant.settings.manage' },
];

/** The sections this person may open. */
export function settingsTabsFor(permissions: readonly Permission[]): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => permissions.includes(tab.permission));
}
