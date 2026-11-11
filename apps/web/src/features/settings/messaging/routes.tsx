import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../../app/guards.js';
import type { FeatureRoute } from '../../../app/registry.js';

const LazyMessagingSettings = lazy(() =>
  import('./MessagingSettingsPage.js').then((module) => ({
    default: module.MessagingSettingsPage,
  })),
);

/** Settings > Mensajes, behind `notifications.manage`. */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'settings',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/messaging',
        component: guardedScreen(['notifications.manage'], LazyMessagingSettings),
      }),
  },
];

export default routes;
