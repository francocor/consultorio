import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../app/registry.js';

const LazyPortal = lazy(() =>
  import('./PortalPage.js').then((module) => ({ default: module.PortalPage })),
);

/**
 * The patient portal, in the shell of its own (`mount: 'portal'`, `app/PortalShell.tsx`). Seam
 * stub of Stage 5: `/portal` shows the scaffold page. The portal track (B, S5.10) replaces it with
 * the sign-in, the subject picker and the sections, adding its routes here.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'portal',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/portal',
        component: LazyPortal,
      }),
  },
];

export default routes;
