import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen, multiModeScreen } from '../../app/guards.js';
import type { FeatureRoute } from '../../app/registry.js';

const LazySubscription = lazy(() =>
  import('./SubscriptionPage.js').then((module) => ({ default: module.SubscriptionPage })),
);

/**
 * The subscription (`/subscription`, in the signed-in shell) for whoever holds `billing.manage`:
 * the owner alone. It exists only on the multi-tenant platform: a single-tenant deployment answers
 * the address like any unknown one. Seam stub of Stage 6: the subscriptions track (A, S6.07) builds
 * the real screen.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/subscription',
        component: guardedScreen(['billing.manage'], multiModeScreen(LazySubscription)),
      }),
  },
];

export default routes;
