import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../app/guards.js';
import type { FeatureRoute } from '../../app/registry.js';

const LazyPrescriptions = lazy(() =>
  import('./PrescriptionsPage.js').then((module) => ({ default: module.PrescriptionsPage })),
);

/**
 * The professional's prescriptions (`/prescriptions`, in the signed-in shell). The navigation entry
 * `prescriptions` belongs to the shell (`app/nav/nav-config.ts`); this feature contributes the
 * screen behind it. Seam stub of Stage 5: the e-Rx track (A3, S5.05) builds the real screen.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/prescriptions',
        component: guardedScreen(['clinical.prescription.read'], LazyPrescriptions),
      }),
  },
];

export default routes;
