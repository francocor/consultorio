import { createRoute, useParams } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../app/registry.js';

const LazyBooking = lazy(() =>
  import('./BookingPage.js').then((module) => ({ default: module.BookingPage })),
);

function BookingRouteComponent() {
  const params: unknown = useParams({ strict: false });
  const slug =
    typeof params === 'object' && params !== null && 'slug' in params ? String(params.slug) : '';
  return <LazyBooking slug={slug} />;
}

/**
 * The public booking page of an organization, in the minimal frame. This is the placeholder of
 * Stage 1; the public booking track replaces it with `features/public-booking`.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'minimal',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/book/$slug',
        component: BookingRouteComponent,
      }),
  },
];

export default routes;
