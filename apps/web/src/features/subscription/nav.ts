import { CreditCard } from 'lucide-react';

import type { NavContribution } from '../../app/registry.js';

/**
 * "Suscripción" for the owner alone (`billing.manage` is owner-only), after "Equipo" in the
 * administration layout, and only on the multi-tenant platform. The id, path and place are the ones
 * of `docs/stage6-tracks.md`; it replaces the entry `billing` that the shell reserved in Stage 1.
 */
const nav: NavContribution = {
  items: [
    {
      id: 'subscription',
      to: '/subscription',
      labelKey: 'subscription:nav',
      icon: CreditCard,
      anyOf: ['billing.manage'],
      multiModeOnly: true,
      placements: [{ layout: 'admin', after: 'staff' }],
    },
  ],
};

export default nav;
