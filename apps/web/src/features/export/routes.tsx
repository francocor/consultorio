import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../app/guards.js';
import type { FeatureRoute } from '../../app/registry.js';

const LazyExport = lazy(() =>
  import('./ExportPage.js').then((module) => ({ default: module.ExportPage })),
);
const LazyClinicalExport = lazy(() =>
  import('./ClinicalExportPage.js').then((module) => ({ default: module.ClinicalExportPage })),
);

/**
 * The two parts of the cancellation export, in the signed-in shell, available while the organization
 * is cancelling, read-only or cancelled (an export is always allowed):
 *
 * - `/export`: the administrative package, for the owner (`billing.manage`, owner-only);
 * - `/export/clinical`: the clinical package of a professional, with the records of their own
 *   patients (`clinical.note.read`, professionals only). An owner who is not a professional never
 *   sees it.
 *
 * Seam stubs of Stage 6: the retention track (C, S6.36) builds the real screens.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/export',
        component: guardedScreen(['billing.manage'], LazyExport),
      }),
  },
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/export/clinical',
        component: guardedScreen(['clinical.note.read'], LazyClinicalExport),
      }),
  },
];

export default routes;
