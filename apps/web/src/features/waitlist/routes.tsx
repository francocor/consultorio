import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../app/registry.js';

const LazyWaitlist = lazy(() =>
  import('./WaitlistPage.js').then((module) => ({ default: module.WaitlistPage })),
);

/** The waitlist screen, in the signed-in shell. The page checks `waitlist.manage` itself. */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/waitlist',
        component: LazyWaitlist,
      }),
  },
];

export default routes;
