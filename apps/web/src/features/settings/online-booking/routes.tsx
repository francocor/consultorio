import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../../app/guards.js';
import type { FeatureRoute } from '../../../app/registry.js';

const LazyOnlineBooking = lazy(() =>
  import('./OnlineBookingPage.js').then((module) => ({ default: module.OnlineBookingPage })),
);

/** Settings > Turnos online, behind `booking.manage`. */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'settings',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/online-booking',
        component: guardedScreen(['booking.manage'], LazyOnlineBooking),
      }),
  },
];

export default routes;
