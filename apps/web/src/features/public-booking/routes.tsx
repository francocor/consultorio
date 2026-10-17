import { createRoute, useParams } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../app/registry.js';

const LazyBooking = lazy(() =>
  import('./BookingPage.js').then((module) => ({ default: module.BookingPage })),
);
const LazyManage = lazy(() =>
  import('./ManagePage.js').then((module) => ({ default: module.ManagePage })),
);

function param(params: unknown, name: string): string {
  return typeof params === 'object' && params !== null && name in params
    ? String((params as Record<string, unknown>)[name])
    : '';
}

function OrganizationRoute() {
  const params: unknown = useParams({ strict: false });
  return <LazyBooking slug={param(params, 'slug')} professionalSlug={null} />;
}

function ProfessionalRoute() {
  const params: unknown = useParams({ strict: false });
  return (
    <LazyBooking
      slug={param(params, 'slug')}
      professionalSlug={param(params, 'professionalSlug')}
    />
  );
}

function ManageRoute() {
  const params: unknown = useParams({ strict: false });
  return <LazyManage token={param(params, 'token')} />;
}

/**
 * The public booking pages, in the minimal frame of the visitors who are not staff: the page of an
 * organization, the page of one professional, and the page behind the link in a confirmation.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'minimal',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/book/manage/$token',
        component: ManageRoute,
      }),
  },
  {
    mount: 'minimal',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/book/$slug/p/$professionalSlug',
        component: ProfessionalRoute,
      }),
  },
  {
    mount: 'minimal',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/book/$slug',
        component: OrganizationRoute,
      }),
  },
];

export default routes;
