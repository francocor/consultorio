import { createRoute, useParams } from '@tanstack/react-router';
import { lazy, type ReactElement } from 'react';

import type { FeatureRoute } from '../../app/registry.js';

const LazyAppointments = lazy(() =>
  import('./pages.js').then((module) => ({ default: module.AppointmentsPage })),
);
const LazyDocuments = lazy(() =>
  import('./pages.js').then((module) => ({ default: module.DocumentsPage })),
);
const LazyConsents = lazy(() =>
  import('./pages.js').then((module) => ({ default: module.ConsentsPage })),
);
const LazyConsent = lazy(() =>
  import('./pages.js').then((module) => ({ default: module.ConsentPage })),
);
const LazyPrescriptions = lazy(() =>
  import('./pages.js').then((module) => ({ default: module.PrescriptionsPage })),
);
const LazyInvoices = lazy(() =>
  import('./pages.js').then((module) => ({ default: module.InvoicesPage })),
);
const LazyProfile = lazy(() =>
  import('./pages.js').then((module) => ({ default: module.ProfilePage })),
);
const LazySessions = lazy(() =>
  import('./pages.js').then((module) => ({ default: module.SessionsPage })),
);

function ConsentRoute() {
  const params: unknown = useParams({ strict: false });
  const id =
    typeof params === 'object' && params !== null && 'id' in params
      ? String((params as Record<string, unknown>)['id'])
      : '';
  return <LazyConsent consentId={id} />;
}

function mount(path: string, component: () => ReactElement): FeatureRoute {
  return {
    mount: 'portal',
    create: (parent) => createRoute({ getParentRoute: () => parent, path, component }),
  };
}

/**
 * The patient portal, in the shell of its own (`mount: 'portal'`, `app/PortalShell.tsx`): the
 * sign-in and the sections of the account, one address each. The pages are lazy chunks, so a
 * member of the staff never downloads them and the sign-in of the application stays as light as
 * it was.
 */
const routes: readonly FeatureRoute[] = [
  mount('/portal', () => <LazyAppointments />),
  mount('/portal/documentos', () => <LazyDocuments />),
  mount('/portal/consentimientos', () => <LazyConsents />),
  mount('/portal/consentimientos/$id', () => <ConsentRoute />),
  mount('/portal/recetas', () => <LazyPrescriptions />),
  mount('/portal/facturas', () => <LazyInvoices />),
  mount('/portal/mis-datos', () => <LazyProfile />),
  mount('/portal/sesiones', () => <LazySessions />),
];

export default routes;
