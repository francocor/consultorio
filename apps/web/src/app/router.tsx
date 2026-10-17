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

import { AuthLayout } from '../features/auth/AuthLayout.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { validateCalendarSearch } from '../features/calendar/search.js';
import { settingsTabsFor } from '../features/settings/settings-tabs.js';
import { SettingsPage } from '../features/settings/SettingsPage.js';
import { isApiError } from '../shared/lib/api-client.js';
import { OfflineBanner } from '../shared/ui/states/banners.js';
import { ErrorState } from '../shared/ui/states/error-state.js';
import { ListSkeleton } from '../shared/ui/states/loading-skeleton.js';

import { AppShell } from './AppShell.js';
import { RequirePermission } from './guards.js';
import { MinimalShell } from './MinimalShell.js';
import { NotFoundPage } from './NotFoundPage.js';
import { useAppStatus } from './providers.js';
import { safeRedirect } from './router-helpers.js';
import type { AppServices } from './services.js';
import { meQueryOptions } from './session.js';

export interface RouterContext {
  services: AppServices;
}

/** The offline banner is global: it shows on every screen, signed in or not. */
function RootLayout() {
  const { online } = useAppStatus();
  return (
    <>
      {online ? null : <OfflineBanner />}
      <Outlet />
    </>
  );
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
    component: RootLayout,
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
    // The landing page of every visitor: eager, so it costs no extra round trip.
    component: LoginPage,
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
    component: guarded(
      ['patients.read'],
      lazyRouteComponent(() => import('../features/patients/PatientsPage.js'), 'PatientsPage'),
    ),
  });

  const newPatientRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/patients/new',
    component: guarded(
      ['patients.write'],
      lazyRouteComponent(() => import('../features/patients/NewPatientPage.js'), 'NewPatientPage'),
    ),
  });

  const patientRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/patients/$patientId',
    // `?tab=chart` opens the clinical chart (links from a note come back to it).
    validateSearch: (search: Record<string, unknown>) => ({
      tab: search['tab'] === 'chart' ? ('chart' as const) : undefined,
    }),
    component: guarded(
      ['patients.read'],
      lazyRouteComponent(
        () => import('../features/patients/PatientDetailPage.js'),
        'PatientDetailPage',
      ),
    ),
  });

  const calendarRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/calendar',
    validateSearch: validateCalendarSearch,
    component: guarded(
      ['scheduling.read'],
      lazyRouteComponent(() => import('../features/calendar/CalendarPage.js'), 'CalendarPage'),
    ),
  });

  const todayRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/today',
    component: guarded(
      ['scheduling.read'],
      lazyRouteComponent(() => import('../features/today/TodayPage.js'), 'TodayPage'),
    ),
  });

  const checkInRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/check-in',
    component: lazyRouteComponent(
      () => import('../features/checkin/CheckInPage.js'),
      'CheckInPage',
    ),
  });

  const worklistRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/worklist',
    component: guarded(
      ['worklist.manage'],
      lazyRouteComponent(() => import('../features/worklist/WorklistPage.js'), 'WorklistPage'),
    ),
  });

  // Clinical records: professionals only (reception, owner and admin see the "no access" screen).
  const noteRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/notes/$noteId',
    component: guarded(
      ['clinical.note.read'],
      lazyRouteComponent(() => import('../features/clinical/NotePage.js'), 'NotePage'),
    ),
  });

  const newEncounterRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/encounters/new',
    validateSearch: (search: Record<string, unknown>) => ({
      patientId: typeof search['patientId'] === 'string' ? search['patientId'] : undefined,
      appointmentId:
        typeof search['appointmentId'] === 'string' ? search['appointmentId'] : undefined,
    }),
    component: guarded(
      ['clinical.note.write'],
      lazyRouteComponent(
        () => import('../features/clinical/NewEncounterPage.js'),
        'NewEncounterPage',
      ),
    ),
  });

  const draftsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/drafts',
    component: guarded(
      ['clinical.note.write'],
      lazyRouteComponent(() => import('../features/clinical/DraftsPage.js'), 'DraftsPage'),
    ),
  });

  const staffRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/staff',
    component: guarded(
      ['staff.manage'],
      lazyRouteComponent(() => import('../features/staff/StaffPage.js'), 'StaffPage'),
    ),
  });

  const auditRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/audit',
    component: guarded(
      ['audit.read'],
      lazyRouteComponent(() => import('../features/audit/AuditPage.js'), 'AuditPage'),
    ),
  });

  // Settings has its own frame (the sections) and checks each section on its own.
  const settingsRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/settings',
    component: SettingsPage,
  });

  const settingsIndexRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/',
    beforeLoad: ({ context }) => {
      const first = settingsTabsFor(context.me.permissions)[0];
      if (first) throw redirect({ to: first.to });
    },
  });

  const settingsLocationsRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/locations',
    component: lazyRouteComponent(
      () => import('../features/settings/LocationsPage.js'),
      'LocationsPage',
    ),
  });

  const settingsSchedulingRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/scheduling',
    component: lazyRouteComponent(
      () => import('../features/settings/scheduling/SchedulingSettingsPage.js'),
      'SchedulingSettingsPage',
    ),
  });

  const settingsBrandingRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/branding',
    component: lazyRouteComponent(
      () => import('../features/settings/BrandingPage.js'),
      'BrandingPage',
    ),
  });

  const settingsSecurityRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/security',
    component: lazyRouteComponent(
      () => import('../features/settings/SecurityPage.js'),
      'SecurityPage',
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
      newPatientRoute,
      patientRoute,
      calendarRoute,
      todayRoute,
      checkInRoute,
      worklistRoute,
      noteRoute,
      newEncounterRoute,
      draftsRoute,
      staffRoute,
      auditRoute,
      settingsRoute.addChildren([
        settingsIndexRoute,
        settingsLocationsRoute,
        settingsSchedulingRoute,
        settingsBrandingRoute,
        settingsSecurityRoute,
      ]),
      unknownRoute,
    ]),
    minimalRoute.addChildren([portalRoute, bookingRoute]),
  ]);
}

const LazyBooking = lazy(() =>
  import('../features/booking/BookingPage.js').then((module) => ({ default: module.BookingPage })),
);

/** The platform host has one screen: the operator console decides between sign-in and content. */
function buildOperatorRouteTree() {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: RootLayout,
    notFoundComponent: function RedirectHome() {
      throw redirect({ to: '/' });
    },
  });
  const consoleRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: lazyRouteComponent(
      () => import('../features/operator/OperatorConsole.js'),
      'OperatorConsole',
    ),
  });
  return rootRoute.addChildren([consoleRoute]);
}

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

/**
 * The router of the platform host. The console shows its own sign-in in place when there is no
 * session, so there is nothing to navigate to when one ends.
 */
export function createOperatorRouter({
  services,
  history,
}: {
  services: AppServices;
  history?: RouterHistory;
}) {
  return createRouter({
    routeTree: buildOperatorRouteTree(),
    context: { services },
    ...(history ? { history } : {}),
    defaultPendingComponent: RoutePending,
    defaultErrorComponent: RouteError,
    defaultPreload: 'intent',
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
export type OperatorRouter = ReturnType<typeof createOperatorRouter>;
