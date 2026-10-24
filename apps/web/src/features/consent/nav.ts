import { FileSignature } from 'lucide-react';

import type { NavContribution } from '../../app/registry.js';

/**
 * "Consentimientos" for whoever manages the templates: the administration after "Pacientes" and the
 * professionals after "Recetas". The ids, paths and places are the ones of `docs/stage5-tracks.md`.
 */
const nav: NavContribution = {
  items: [
    {
      id: 'consents',
      to: '/consents',
      labelKey: 'consent:nav',
      icon: FileSignature,
      anyOf: ['consent.template.manage'],
      placements: [
        { layout: 'admin', after: 'patients' },
        { layout: 'professional', after: 'prescriptions' },
      ],
    },
  ],
};

export default nav;
