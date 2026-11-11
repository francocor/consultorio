import { Receipt } from 'lucide-react';

import type { NavContribution } from '../../app/registry.js';

/**
 * "Cobros" in the navigation of whoever reads payments: reception after the check-in, the
 * administration after the patients, and the professionals at the end (their own appointments). The
 * ids, paths and places are the ones of `docs/stage4-tracks.md`. The price list is a section of
 * Settings for whoever manages prices.
 */
const nav: NavContribution = {
  items: [
    {
      id: 'charges',
      to: '/charges',
      labelKey: 'billing:nav',
      icon: Receipt,
      anyOf: ['payments.read'],
      placements: [
        { layout: 'reception', after: 'check-in' },
        { layout: 'admin', after: 'patients' },
        { layout: 'professional' },
      ],
    },
  ],
  settingsTabs: [
    {
      id: 'billing-prices',
      to: '/settings/prices',
      labelKey: 'billing:tab',
      permission: 'pricing.manage',
    },
  ],
};

export default nav;
