import type { NavContribution } from '../../app/registry.js';

/**
 * The entry "Recetas" of the professional belongs to the shell (`app/nav/nav-config.ts`). What this
 * feature adds is the connection to the provider, a section of Settings for whoever manages the
 * organization (owner and admin).
 */
const nav: NavContribution = {
  items: [],
  settingsTabs: [
    {
      id: 'prescriptions',
      to: '/settings/prescriptions',
      labelKey: 'prescriptions:settingsTab',
      permission: 'tenant.settings.manage',
    },
  ],
};

export default nav;
