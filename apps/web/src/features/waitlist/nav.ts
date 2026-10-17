import { Hourglass } from 'lucide-react';

import type { NavContribution } from '../../app/registry.js';

/**
 * "Lista de espera" in the navigation of the people who run it: reception, the administration and
 * the professionals. It goes at the end of each list, so the bottom bar of a phone keeps the
 * entries people already know in the places they know them (the rest wait under "Más").
 */
const nav: NavContribution = {
  items: [
    {
      id: 'waitlist',
      to: '/waitlist',
      labelKey: 'waitlist:nav',
      icon: Hourglass,
      anyOf: ['waitlist.manage'],
      placements: [{ layout: 'reception' }, { layout: 'admin' }, { layout: 'professional' }],
    },
  ],
};

export default nav;
