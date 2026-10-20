import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../../app/registry.js';

const LazySignup = lazy(() =>
  import('./SignupPage.js').then((module) => ({ default: module.SignupPage })),
);
const LazyVerify = lazy(() =>
  import('./VerifyPage.js').then((module) => ({ default: module.VerifyPage })),
);

/**
 * The two pages of the signup, each on the host it belongs to:
 *
 * - `/signup` on the PLATFORM host, in the frame of the product, with no session and no
 *   organization. A single-tenant deployment has no platform host, so it has no such page;
 * - `/signup/verify` on the host of the organization the emailed link activates, in the minimal
 *   frame of the visitors who are not staff (the organization's name, nothing else). The link is
 *   the only thing that reaches it, and what it does is on the API: an organization that is not
 *   waiting for a confirmation answers it with a link that does not work.
 *
 * Both are lazy chunks: they cost the sign-in page nothing.
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
  {
    mount: 'minimal',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/signup/verify',
        component: LazyVerify,
      }),
  },
];

export default routes;
