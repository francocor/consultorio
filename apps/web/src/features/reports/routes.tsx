import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../app/registry.js';

const LazyReports = lazy(() =>
  import('./ReportsPage.js').then((module) => ({ default: module.ReportsPage })),
);

/** The reports dashboard, in the signed-in shell. The page checks `reports.read` itself. */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/reports',
        component: LazyReports,
      }),
  },
];

export default routes;
