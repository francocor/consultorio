import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../../app/registry.js';

const LazySignup = lazy(() =>
  import('./SignupPage.js').then((module) => ({ default: module.SignupPage })),
);

/**
 * The public signup (`/signup`), on the platform host in the frame of the product, with no session
 * and no organization. A single-tenant deployment has no platform host, so it has no such page.
 * Seam stub of Stage 6: the signup track (B, S6.07) builds the real screen, and adds its other
 * addresses (the verification landing) here.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'platform',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/signup',
        component: LazySignup,
      }),
  },
];

export default routes;
