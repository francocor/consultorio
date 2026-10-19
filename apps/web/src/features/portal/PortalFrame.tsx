import type { PortalLinkDto, PortalMeResponse } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LogOut, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { DetailSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { portalApi, portalKeys } from './api/portal-api.js';
import { SignIn } from './SignIn.js';
import { relationLabel, SubjectPicker } from './SubjectPicker.js';

/** The sections of the portal, in the order the navigation shows them. */
const SECTIONS = [
  { to: '/portal', key: 'appointments' },
  { to: '/portal/documentos', key: 'documents' },
  { to: '/portal/consentimientos', key: 'consents' },
  { to: '/portal/recetas', key: 'prescriptions' },
  { to: '/portal/facturas', key: 'invoices' },
  { to: '/portal/mis-datos', key: 'profile' },
] as const;

export interface PortalSubjectContext {
  me: PortalMeResponse;
  /** The record that is shown. */
  link: PortalLinkDto;
}

/**
 * The frame of every screen of the portal. It asks who is signed in: nobody gets the sign-in, a
 * person with several records picks one, and with one in view the header names whose information
 * it is, always. The sections render inside it and receive the record that is shown.
 */
export function PortalFrame({
  children,
  navigation = true,
}: {
  children: (context: PortalSubjectContext) => ReactNode;
  /** The pages of the account (sessions) show the frame without the sections' navigation. */
  navigation?: boolean;
}) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const queryClient = useQueryClient();
  const [choosing, setChoosing] = useState(false);

  const me = useQuery({ queryKey: portalKeys.me, queryFn: () => api.me() });
  const pick = useMutation({
    mutationFn: (linkId: string) => api.selectSubject(linkId),
    onSuccess: (next) => {
      setChoosing(false);
      queryClient.setQueryData(portalKeys.me, next);
      // What was read for another record is not this one's.
      void queryClient.invalidateQueries({ queryKey: ['portal', 'subject'] });
    },
  });
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSettled: async () => {
      queryClient.removeQueries({ queryKey: portalKeys.all });
      await queryClient.invalidateQueries({ queryKey: portalKeys.me });
    },
  });

  if (me.isPending) return <DetailSkeleton />;
  if (me.isError) {
    // Nobody is signed in (or the session ended): the portal opens on the sign-in.
    if (isApiError(me.error) && me.error.status === 401) return <SignIn />;
    return (
      <ErrorState
        error={me.error}
        onRetry={() => {
          void me.refetch();
        }}
      />
    );
  }

  const data = me.data;
  const active = data.links.filter((link) => link.status === 'active');
  const suspended = data.links.filter((link) => link.status === 'suspended');
  const current = active.find((link) => link.id === data.selectedLinkId);

  const notices = suspended.length > 0 && (
    <Alert tone="warning" className="mb-4">
      <AlertDescription>
        {suspended.map((link) => (
          <span key={link.id} className="block">
            {t('subject.suspended', { name: link.patientName })}
          </span>
        ))}
      </AlertDescription>
    </Alert>
  );

  const signOut = (
    <Button
      variant="ghost"
      size="sm"
      loading={logout.isPending}
      onClick={() => {
        logout.mutate();
      }}
    >
      <LogOut aria-hidden="true" />
      {t('frame.signOut')}
    </Button>
  );

  if (active.length === 0) {
    return (
      <div className="grid gap-4">
        {notices}
        <EmptyState
          title={t('frame.noAccess.title')}
          description={t('frame.noAccess.description')}
          action={signOut}
        />
      </div>
    );
  }

  if (!current || choosing) {
    return (
      <div className="grid gap-4">
        {notices}
        <SubjectPicker
          links={active}
          current={current?.id ?? null}
          picking={pick.isPending}
          onPick={(linkId) => {
            pick.mutate(linkId);
          }}
          {...(current
            ? {
                onCancel: () => {
                  setChoosing(false);
                },
              }
            : {})}
        />
        {pick.error ? <ErrorState error={pick.error} /> : null}
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      {notices}
      <header className="grid gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-0.5">
            <p className="text-xs text-muted-foreground">{t('frame.viewing')}</p>
            <p className="break-words font-display text-lg font-semibold leading-tight">
              {current.patientName}
            </p>
            {current.relationship === 'representative' ? (
              <p className="text-sm text-muted-foreground">
                {t('frame.asRepresentative', { relation: relationLabel(t, current) })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {active.length > 1 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setChoosing(true);
                }}
              >
                <Users aria-hidden="true" />
                {t('frame.switch')}
              </Button>
            ) : null}
            {signOut}
          </div>
        </div>
        {navigation ? (
          <nav aria-label={t('frame.navigation')} className="-mx-1 max-w-full overflow-x-auto">
            <ul className="flex min-w-max gap-1 px-1">
              {SECTIONS.map(({ to, key }) => (
                <li key={to}>
                  <Link
                    to={to}
                    activeOptions={{ exact: true }}
                    className="touch-target-md inline-flex items-center rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent data-[status=active]:bg-primary-soft data-[status=active]:font-semibold data-[status=active]:text-foreground"
                  >
                    {t(`frame.sections.${key}`)}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  to="/portal/sesiones"
                  className="touch-target-md inline-flex items-center rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent data-[status=active]:bg-primary-soft data-[status=active]:font-semibold data-[status=active]:text-foreground"
                >
                  {t('frame.sections.sessions')}
                </Link>
              </li>
            </ul>
          </nav>
        ) : null}
      </header>
      {children({ me: data, link: current })}
    </div>
  );
}
