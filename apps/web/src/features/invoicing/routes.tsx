import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import { guardedScreen } from '../../app/guards.js';
import type { FeatureRoute } from '../../app/registry.js';

const LazyInvoices = lazy(() =>
  import('./InvoicesPage.js').then((module) => ({ default: module.InvoicesPage })),
);
const LazyInvoicingSettings = lazy(() =>
  import('./settings/InvoicingSettingsPage.js').then((module) => ({
    default: module.InvoicingSettingsPage,
  })),
);

/**
 * The invoices (`/invoices`, in the signed-in shell; the page checks `invoicing.issue` itself) and
 * Settings > Facturacion, behind `invoicing.configure`. Both load when they are opened, so the entry
 * chunk holds none of the invoicing screens.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/invoices',
        component: LazyInvoices,
      }),
  },
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
