import { createRoute, useParams, useSearch } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../../app/registry.js';

const LazyJoin = lazy(() =>
  import('./WaitlistJoinPage.js').then((module) => ({ default: module.WaitlistJoinPage })),
);

function param(params: unknown, name: string): string {
  return typeof params === 'object' && params !== null && name in params
    ? String((params as Record<string, unknown>)[name])
    : '';
}

/** What the address may carry: the type and the place the visitor was choosing a time for. */
interface JoinSearch {
  type?: string;
  location?: string;
}

function JoinRoute() {
  const params: unknown = useParams({ strict: false });
  const search: JoinSearch = useSearch({ strict: false });
  return (
    <LazyJoin
      slug={param(params, 'slug')}
      professionalSlug={param(params, 'professionalSlug')}
      typeId={search.type}
      locationId={search.location}
    />
  );
}

/** The public page to join the waitlist of a professional, in the minimal frame of the visitors. */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'minimal',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/book/$slug/p/$professionalSlug/waitlist',
        validateSearch: (search: Record<string, unknown>): JoinSearch => ({
          ...(typeof search['type'] === 'string' ? { type: search['type'] } : {}),
          ...(typeof search['location'] === 'string' ? { location: search['location'] } : {}),
        }),
        component: JoinRoute,
      }),
  },
];

export default routes;
