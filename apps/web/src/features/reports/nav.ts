import { ChartColumn } from 'lucide-react';

import type { NavContribution } from '../../app/registry.js';

/**
 * "Informes" for the people who read how the practice is doing. Owner and admin find it after
 * "Equipo"; reception and professionals at the end of their lists. What each one sees inside is
 * decided by the server (a professional their own appointments, reception its locations).
 */
const nav: NavContribution = {
  items: [
    {
      id: 'reports',
      to: '/reports',
      labelKey: 'reports:nav',
      icon: ChartColumn,
      anyOf: ['reports.read'],
      placements: [
        { layout: 'admin', after: 'staff' },
        { layout: 'reception' },
        { layout: 'professional' },
      ],
    },
  ],
};

export default nav;
