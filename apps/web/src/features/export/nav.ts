import { PackageOpen } from 'lucide-react';

import type { NavContribution } from '../../app/registry.js';

/**
 * "Exportación" for the owner alone, after "Auditoría" in the administration layout, in every
 * deployment (the operator can cancel a single-tenant one too). The professional's clinical package
 * has no entry of its own: a professional reaches it from the notice they receive when the
 * organization is cancelled. The id, path and place are the ones of `docs/stage6-tracks.md`.
 */
const nav: NavContribution = {
  items: [
    {
      id: 'export',
      to: '/export',
      labelKey: 'export:nav',
      icon: PackageOpen,
      anyOf: ['billing.manage'],
      placements: [{ layout: 'admin', after: 'audit' }],
    },
  ],
};

export default nav;
