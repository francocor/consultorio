import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../app/guards.js';
import type { FeatureRoute } from '../../app/registry.js';

const LazyInvoicingSettings = lazy(() =>
  import('./settings/InvoicingSettingsPage.js').then((module) => ({
    default: module.InvoicingSettingsPage,
  })),
);

/** Settings > Facturacion, behind `invoicing.configure`. */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'settings',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/invoicing',
        component: guardedScreen(['invoicing.configure'], LazyInvoicingSettings),
      }),
  },
];

export default routes;
