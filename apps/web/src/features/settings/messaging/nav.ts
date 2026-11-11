import type { NavContribution } from '../../../app/registry.js';

/** The "Mensajes" section of Settings, for whoever manages notifications. */
const nav: NavContribution = {
  settingsTabs: [
    {
      id: 'messaging',
      to: '/settings/messaging',
      labelKey: 'messaging:tab',
      permission: 'notifications.manage',
    },
  ],
};

export default nav;
