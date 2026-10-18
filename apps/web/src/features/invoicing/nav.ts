import type { NavContribution } from '../../app/registry.js';

/**
 * The "Facturacion" section of Settings, for whoever configures invoicing (owner and admin). The
 * `invoices` entry of the sidebar arrives with the issue screens (S4.13).
 */
const nav: NavContribution = {
  settingsTabs: [
    {
      id: 'invoicing',
      to: '/settings/invoicing',
      labelKey: 'invoicing:tab',
      permission: 'invoicing.configure',
    },
  ],
};

export default nav;
