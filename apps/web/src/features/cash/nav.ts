import { Wallet } from 'lucide-react';

import type { NavContribution } from '../../app/registry.js';

/** "Caja" for whoever operates the cash register: reception, right after the patients. */
const nav: NavContribution = {
  items: [
    {
      id: 'cash',
      to: '/cash',
      labelKey: 'cash:nav',
      icon: Wallet,
      anyOf: ['cash.operate'],
      placements: [{ layout: 'reception', after: 'patients' }],
    },
  ],
};

export default nav;
