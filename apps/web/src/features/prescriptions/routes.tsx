import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../app/guards.js';
import type { FeatureRoute } from '../../app/registry.js';

const LazyPrescriptions = lazy(() =>
  import('./PrescriptionsPage.js').then((module) => ({ default: module.PrescriptionsPage })),
);
const LazyConnectionSettings = lazy(() =>
  import('./settings/ConnectionSettingsPage.js').then((module) => ({
    default: module.ConnectionSettingsPage,
  })),
);

/**
 * The professional's prescriptions (`/prescriptions`, in the signed-in shell) and Settings > Recetas
 * electronicas, behind `tenant.settings.manage` (owner and admin). The navigation entry
 * `prescriptions` belongs to the shell (`app/nav/nav-config.ts`); this feature contributes the
 * screens behind it. Both load when they are opened, so the entry chunk holds none of them.
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
  {
    mount: 'settings',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/prescriptions',
        component: guardedScreen(['tenant.settings.manage'], LazyConnectionSettings),
      }),
  },
];

export default routes;
