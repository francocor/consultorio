import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../app/guards.js';
import type { FeatureRoute } from '../../app/registry.js';

const LazyConsents = lazy(() =>
  import('./ConsentPage.js').then((module) => ({ default: module.ConsentPage })),
);

/**
 * The template manager (`/consents`, in the signed-in shell) for whoever holds
 * `consent.template.manage`: the owner, the admin and the professionals. Seam stub of Stage 5: the
 * consent track (A2, S5.11) builds the real screen.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/consents',
        component: guardedScreen(['consent.template.manage'], LazyConsents),
      }),
  },
];

export default routes;
