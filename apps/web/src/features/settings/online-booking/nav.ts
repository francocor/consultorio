import type { NavContribution } from '../../../app/registry.js';

/** The "Turnos online" section of Settings, for whoever manages online booking. */
const nav: NavContribution = {
  settingsTabs: [
    {
      id: 'online-booking',
      to: '/settings/online-booking',
      labelKey: 'bookingAdmin:tab',
      permission: 'booking.manage',
    },
  ],
};

export default nav;
