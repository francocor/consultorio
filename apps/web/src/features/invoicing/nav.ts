import { FileText } from 'lucide-react';

import type { NavContribution } from '../../app/registry.js';

/**
 * "Facturas" in the navigation of whoever issues invoices: reception at the end, the administration
 * after the charges. The ids, paths and places are the ones of `docs/stage4-tracks.md`. The fiscal
 * configuration is a section of Settings for whoever configures invoicing (owner and admin).
 */
const nav: NavContribution = {
  items: [
    {
      id: 'invoices',
      to: '/invoices',
      labelKey: 'invoicing:nav',
      icon: FileText,
      anyOf: ['invoicing.issue'],
      placements: [{ layout: 'reception' }, { layout: 'admin', after: 'charges' }],
    },
  ],
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
