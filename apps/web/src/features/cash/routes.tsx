import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../app/registry.js';

const LazyCash = lazy(() =>
  import('./CashPage.js').then((module) => ({ default: module.CashPage })),
);

/** The cash register, in the signed-in shell. The page checks `cash.operate` itself. */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/cash',
        component: LazyCash,
      }),
  },
];

export default routes;
