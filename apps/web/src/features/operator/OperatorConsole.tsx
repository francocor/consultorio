import type { DevProviderDto, OperatorDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { Button } from '../../shared/ui/button.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../shared/ui/tabs.js';

import { operatorApi, operatorKeys } from './api/operator-api.js';
import { ProvidersPage } from './dev/ProvidersPage.js';
import { HolidayCatalog } from './holidays/HolidayCatalog.js';
import { MatriculaQueue } from './matricula/MatriculaQueue.js';
import { OperatorLogin } from './OperatorLogin.js';
import { TenantsPanel } from './TenantsPanel.js';

/** The platform console: the sign-in when there is no session, and the organizations when there is. */
export function OperatorConsole() {
  const { t } = useTranslation('operator');
  usePageTitle(t('title'));
  const api = useApi();
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: operatorKeys.me,
    queryFn: async (): Promise<OperatorDto | null> => {
      try {
        return await operatorApi(api).me();
      } catch (error) {
        if (isApiError(error) && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });

  if (session.isPending) {
    return (
      <div className="mx-auto w-full max-w-md p-6">
        <FormSkeleton fields={3} />
      </div>
    );
  }
  if (session.isError) {
    return (
      <div className="mx-auto w-full max-w-xl p-6">
        <ErrorState
          error={session.error}
          onRetry={() => {
            void session.refetch();
          }}
        />
      </div>
    );
  }
  if (session.data === null) {
    return (
      <OperatorLogin
        onSignedIn={(operator) => {
          queryClient.setQueryData(operatorKeys.me, operator);
        }}
      />
    );
  }
  return (
    <Console
      operator={session.data}
      onSignedOut={() => {
        // Nothing of the signed-out session stays in memory: the list goes, the profile becomes "none".
        queryClient.removeQueries({ queryKey: operatorKeys.tenants });
        queryClient.setQueryData(operatorKeys.me, null);
      }}
    />
  );
}

function Console({ operator, onSignedOut }: { operator: OperatorDto; onSignedOut: () => void }) {
  const { t } = useTranslation('operator');
  const api = useApi();
  // The provider console exists only where the server was started with LOCAL_PROVIDERS_CONSOLE;
  // anywhere else this is a 404 and the tab is simply not offered.
  const providers = useQuery({
    queryKey: operatorKeys.devProviders,
    queryFn: async (): Promise<readonly DevProviderDto[] | null> => {
      try {
        return await operatorApi(api).devProviders();
      } catch {
        return null;
      }
    },
    retry: false,
  });
  const signOut = useMutation({
    mutationFn: () => operatorApi(api).logout(),
    // Whatever the server answered, nothing of this session stays in the browser.
    onSettled: onSignedOut,
  });

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b bg-card px-4 py-3 md:px-8">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <p className="flex items-center gap-2 font-display text-sm font-semibold">
            <span
              aria-hidden="true"
              className="grid size-9 place-content-center rounded-md bg-primary text-primary-foreground"
            >
              <ShieldCheck className="size-5" />
            </span>
            {t('brand')}
          </p>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{operator.email}</span>
            <Button
              variant="outline"
              size="sm"
              loading={signOut.isPending}
              onClick={() => {
                signOut.mutate();
              }}
            >
              <LogOut aria-hidden="true" />
              {t('signOut')}
            </Button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-8">
        <Tabs defaultValue="tenants" className="grid grid-cols-1 gap-6">
          <TabsList aria-label={t('nav.label')} className="justify-start">
            <TabsTrigger value="tenants">{t('nav.tenants')}</TabsTrigger>
            <TabsTrigger value="holidays">{t('nav.holidays')}</TabsTrigger>
            <TabsTrigger value="matricula">{t('matricula.nav')}</TabsTrigger>
            {providers.data ? (
              <TabsTrigger value="providers">{t('nav.providers')}</TabsTrigger>
            ) : null}
          </TabsList>
          <TabsContent value="tenants">
            <TenantsPanel />
          </TabsContent>
          <TabsContent value="holidays">
            <HolidayCatalog />
          </TabsContent>
          <TabsContent value="matricula">
            <MatriculaQueue />
          </TabsContent>
          {providers.data ? (
            <TabsContent value="providers">
              <ProvidersPage providers={providers.data} />
            </TabsContent>
          ) : null}
        </Tabs>
      </main>
    </div>
  );
}
