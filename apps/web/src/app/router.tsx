import type { Permission } from '@consultorio/contracts';
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useParams,
  useRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { lazy, type ComponentType } from 'react';

import { AuditPage } from '../features/audit/AuditPage.js';
import { AuthLayout } from '../features/auth/AuthLayout.js';
import { PatientsPage } from '../features/patients/PatientsPage.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
import { StaffPage } from '../features/staff/StaffPage.js';
import { isApiError } from '../shared/lib/api-client.js';
import { ErrorState } from '../shared/ui/states/error-state.js';
import { ListSkeleton } from '../shared/ui/states/loading-skeleton.js';

import { AppShell } from './AppShell.js';
import { RequirePermission } from './guards.js';
import { MinimalShell } from './MinimalShell.js';
import { NotFoundPage } from './NotFoundPage.js';
import { safeRedirect } from './router-helpers.js';
import type { AppServices } from './services.js';
import { meQueryOptions } from './session.js';

export interface RouterContext {
  services: AppServices;
}

function RouteError({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-xl p-6">
      <ErrorState
        error={error}
        onRetry={() => {
          void router.invalidate();
        }}
      />
    </div>
  );
}

function RoutePending() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <ListSkeleton rows={4} />
    </div>
  );
}

/** One route tree per router, so tests (and a tenant switch) never share route state. */
function buildRouteTree() {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
    notFoundComponent: NotFoundPage,
  });

  // Screens a visitor sees before signing in share one calm frame.
  const publicRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'public',
    component: AuthLayout,
  });

  const loginRoute = createRoute({
    getParentRoute: () => publicRoute,
    path: '/login',
    validateSearch: (search: Record<string, unknown>) => ({
      redirect: safeRedirect(search['redirect']),
      reason: search['reason'] === 'expired' ? ('expired' as const) : undefined,
    }),
    component: lazyRouteComponent(() => import('../features/auth/LoginPage.js'), 'LoginPage'),
  });

  const forgotRoute = createRoute({
    getParentRoute: () => publicRoute,
    path: '/forgot-password',
    component: lazyRouteComponent(
      () => import('../features/auth/ForgotPasswordPage.js'),
      'ForgotPasswordPage',
    ),
  });

  const resetRoute = createRoute({
    getParentRoute: () => publicRoute,
    path: '/reset-password',
    component: lazyRouteComponent(
      () => import('../features/auth/ResetPasswordPage.js'),
      'ResetPasswordPage',
    ),
  });

  const invitationRoute = createRoute({
    getParentRoute: () => publicRoute,
    path: '/accept-invitation',
    component: lazyRouteComponent(
      () => import('../features/auth/AcceptInvitationPage.js'),
      'AcceptInvitationPage',
    ),
  });

  // Everything below needs a session. The route loads the profile first, so the shell and every
  // screen can rely on it; no session means the sign-in screen.
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'authed',
    beforeLoad: async ({ context, location }) => {
      const { queryClient, api } = context.services;
      let me;
      try {
        me = await queryClient.query(meQueryOptions(api));
      } catch (error) {
        if (isApiError(error) && error.status === 401) me = null;
        else throw error;
      }
      if (!me) {
        throw redirect({ to: '/login', search: { redirect: safeRedirect(location.href) } });
      }
      const enrolling = location.pathname.startsWith('/account');
      if (me.scope === 'two_factor_enrollment' && !enrolling) {
        throw redirect({ to: '/account/security' });
      }
      return { me };
    },
    component: AppShell,
  });

  const homeRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/',
    component: lazyRouteComponent(() => import('../features/home/HomePage.js'), 'HomePage'),
  });

  const securityRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/account/security',
    component: lazyRouteComponent(
      () => import('../features/auth/AccountSecurityPage.js'),
      'AccountSecurityPage',
    ),
  });

  const guarded = (anyOf: readonly Permission[], Screen: ComponentType) =>
    function GuardedScreen() {
      return (
        <RequirePermission anyOf={anyOf}>
          <Screen />
        </RequirePermission>
      );
    };

  const patientsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/patients',
    component: guarded(['patients.read'], PatientsPage),
  });

  const staffRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/staff',
    component: guarded(['staff.manage'], StaffPage),
  });

  const auditRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/audit',
    component: guarded(['audit.read'], AuditPage),
  });

  const settingsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/settings',
    component: guarded(
      ['tenant.settings.manage', 'tenant.branding.manage', 'locations.manage'],
      SettingsPage,
    ),
  });

  // Any other address inside the signed-in area keeps the shell around the "not found" message.
  const unknownRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '$',
    component: NotFoundPage,
  });

  // The patient portal and public booking have their own minimal shell.
  const minimalRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'minimal',
    component: MinimalShell,
  });

  const portalRoute = createRoute({
    getParentRoute: () => minimalRoute,
    path: '/portal',
    component: lazyRouteComponent(() => import('../features/portal/PortalPage.js'), 'PortalPage'),
  });

  const bookingRoute = createRoute({
    getParentRoute: () => minimalRoute,
    path: '/book/$slug',
    component: function BookingRouteComponent() {
      const params: unknown = useParams({ strict: false });
      const slug =
        typeof params === 'object' && params !== null && 'slug' in params
          ? String(params.slug)
          : '';
      return <LazyBooking slug={slug} />;
    },
  });

  return rootRoute.addChildren([
    publicRoute.addChildren([loginRoute, forgotRoute, resetRoute, invitationRoute]),
    authedRoute.addChildren([
      homeRoute,
      securityRoute,
      patientsRoute,
      staffRoute,
      auditRoute,
      settingsRoute,
      unknownRoute,
    ]),
    minimalRoute.addChildren([portalRoute, bookingRoute]),
  ]);
}

const LazyBooking = lazy(() =>
  import('../features/booking/BookingPage.js').then((module) => ({ default: module.BookingPage })),
);

export function createAppRouter({
  services,
  history,
}: {
  services: AppServices;
  history?: RouterHistory;
}) {
  const router = createRouter({
    routeTree: buildRouteTree(),
    context: { services },
    ...(history ? { history } : {}),
    defaultPendingComponent: RoutePending,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFoundPage,
    defaultPreload: 'intent',
  });

  // A 401 in the middle of a session: go to sign-in and come back to where the person was.
  services.onSessionEnded(() => {
    const here = safeRedirect(router.state.location.href);
    void router.navigate({ to: '/login', search: { redirect: here, reason: 'expired' } });
  });

  return router;
}

export type AppRouter = ReturnType<typeof createAppRouter>;
