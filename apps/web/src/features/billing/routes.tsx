import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../app/guards.js';
import type { FeatureRoute } from '../../app/registry.js';

const LazyCharges = lazy(() =>
  import('./ChargesPage.js').then((module) => ({ default: module.ChargesPage })),
);
const LazyPrices = lazy(() =>
  import('./PricesSettingsPage.js').then((module) => ({ default: module.PricesSettingsPage })),
);

/**
 * The charges screen (`/charges`, in the signed-in shell; the page checks `payments.read` itself) and
 * Settings > Precios y obras sociales (`pricing.manage`). The shell id and path `billing` belong to the
 * subscription of Stage 6, which is why this one is `/charges`.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/charges',
        component: LazyCharges,
      }),
  },
  {
    mount: 'settings',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/prices',
        component: guardedScreen(['pricing.manage'], LazyPrices),
      }),
  },
];

export default routes;
