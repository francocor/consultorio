import { createRoute } from '@tanstack/react-router';
import { lazy } from 'react';

import type { FeatureRoute } from '../../app/registry.js';

const LazyReports = lazy(() =>
  import('./ReportsPage.js').then((module) => ({ default: module.ReportsPage })),
);
// The money and cash reports bring their own code when they are opened.
const LazyFinancial = lazy(() =>
  import('./financial/FinancialReportPage.js').then((module) => ({
    default: module.FinancialReportPage,
  })),
);
const LazyCash = lazy(() =>
  import('./financial/CashReportPage.js').then((module) => ({ default: module.CashReportPage })),
);

/**
 * The reports, in the signed-in shell: the dashboard of appointments, the money report and the cash
 * register report. Each page checks `reports.read` itself; what is inside is cut by the server.
 */
const routes: readonly FeatureRoute[] = [
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/reports',
        component: LazyReports,
      }),
  },
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/reports/financial',
        component: LazyFinancial,
      }),
  },
  {
    mount: 'authed',
    create: (parent) =>
      createRoute({
        getParentRoute: () => parent,
        path: '/reports/cash',
        component: LazyCash,
      }),
  },
];

export default routes;
