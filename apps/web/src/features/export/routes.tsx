import { createRoute, useParams } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../app/guards.js';
import type { FeatureRoute } from '../../app/registry.js';

const LazyExport = lazy(() =>
  import('./ExportPage.js').then((module) => ({ default: module.ExportPage })),
);
const LazyClinicalExport = lazy(() =>
  import('./ClinicalExportPage.js').then((module) => ({ default: module.ClinicalExportPage })),
);
const LazyRelease = lazy(() =>
  import('./ArchiveReleasePage.js').then((module) => ({ default: module.ArchiveReleasePage })),
);

function ReleaseRoute() {
  const params: unknown = useParams({ strict: false });
  const token =
    typeof params === 'object' && params !== null && 'token' in params
      ? String((params as Record<string, unknown>)['token'])
      : '';
  return <LazyRelease token={token} />;
}

/**
 * The two parts of the cancellation export, in the signed-in shell, available while the organization
 * is cancelling, read-only or cancelled (an export is always allowed):
 *
 * - `/export`: the administrative package, for the owner (`billing.manage`, owner-only);
 * - `/export/clinical`: the clinical package of a professional, with the records of their own
 *   patients (`clinical.note.read`, professionals only). An owner who is not a professional never
 *   sees it.
 *
 * Also the page of the emailed release link (`/archive-release/$token`, task 6.43), in the minimal
 * frame: the requester of a break-glass release has no session, the link is the whole credential.
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
  {
    mount: 'minimal',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/archive-release/$token',
        component: ReleaseRoute,
      }),
  },
];

export default routes;
