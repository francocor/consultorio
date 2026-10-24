import type { ErxConnectionDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../../app/guards.js';
import { useApi } from '../../../app/providers.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import { Button } from '../../../shared/ui/button.js';
import { Switch } from '../../../shared/ui/checkbox.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { prescriptionKeys, prescriptionsApi } from '../api/prescriptions-api.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { SimulatedPrescriptionNotice } from '../components/SimulatedPrescriptionNotice.js';

/** Settings > Recetas electronicas: the connection to the provider. Owners and administrators. */
export function ConnectionSettingsPage() {
  return (
    <RequirePermission anyOf={['tenant.settings.manage']}>
      <Connection />
    </RequirePermission>
  );
}

function Connection() {
  const { t } = useTranslation('prescriptions');
  usePageTitle(t('settings.title'));
  const api = useApi();
  const connection = useQuery({
    queryKey: prescriptionKeys.connection,
    queryFn: () => prescriptionsApi(api).connection(),
  });

  if (connection.isPending) return <FormSkeleton fields={3} />;
  if (connection.isError) {
    return (
      <ErrorState
        error={connection.error}
        onRetry={() => {
          void connection.refetch();
        }}
      />
    );
  }
  return <ConnectionForms connection={connection.data} />;
}

function ConnectionForms({ connection }: { connection: ErxConnectionDto }) {
  const { t } = useTranslation('prescriptions');
  const api = useApi();
  const queryClient = useQueryClient();
  const [credentials, setCredentials] = useState('');

  const save = useMutation({
    mutationFn: (body: { enabled: boolean; credentials?: string }) =>
      prescriptionsApi(api).saveConnection(body),
    onSuccess: async () => {
      toast.success(t('settings.saved'));
      setCredentials('');
      await queryClient.invalidateQueries({ queryKey: prescriptionKeys.all });
    },
  });
  // The simulator needs no credentials; a real provider does, and they are never shown again.
  const needsCredentials = connection.providerAvailable && !connection.simulated;

  return (
    <div className="grid max-w-3xl gap-4">
      <SimulatedPrescriptionNotice />
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('settings.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.description')}</p>
      </div>

      <section
        aria-labelledby="erx-status-title"
        className="grid gap-2 rounded-lg border bg-card p-4"
      >
        <h3 id="erx-status-title" className="font-medium">
          {t('settings.status.title')}
        </h3>
        {connection.providerAvailable ? (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />
            {connection.simulated ? t('settings.status.simulated') : t('settings.status.available')}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm">
            <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
            {t('settings.status.none')}
          </p>
        )}
      </section>

      <section
        aria-labelledby="erx-enable-title"
        className="grid gap-3 rounded-lg border bg-card p-4"
      >
        <ErrorAlert error={save.error} />
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-0.5">
            <h3 id="erx-enable-title" className="font-medium">
              {t('settings.enable.title')}
            </h3>
            <p id="erx-enable-description" className="text-sm text-muted-foreground">
              {t('settings.enable.description')}
            </p>
            <p id="erx-enable-switch-label" className="mt-1 text-sm font-medium">
              {t('settings.enable.switch')}
            </p>
          </div>
          <Switch
            aria-labelledby="erx-enable-switch-label"
            aria-describedby="erx-enable-description"
            checked={connection.enabled}
            disabled={save.isPending || !connection.providerAvailable}
            onCheckedChange={(on) => {
              save.mutate({ enabled: on });
            }}
          />
        </div>
      </section>

      {needsCredentials ? (
        <section
          aria-labelledby="erx-credentials-title"
          className="grid gap-3 rounded-lg border bg-card p-4"
        >
          <h3 id="erx-credentials-title" className="font-medium">
            {t('settings.credentials.title')}
          </h3>
          <p className="flex items-center gap-2 text-sm">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {connection.credentialsSaved
              ? t('settings.credentials.saved')
              : t('settings.credentials.none')}
          </p>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (credentials.trim() !== '' && !save.isPending) {
                save.mutate({ enabled: connection.enabled, credentials: credentials.trim() });
              }
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="erx-credentials">{t('settings.credentials.label')}</Label>
              <Input
                id="erx-credentials"
                type="password"
                autoComplete="off"
                aria-describedby="erx-credentials-help"
                value={credentials}
                onChange={(event) => {
                  setCredentials(event.target.value);
                }}
              />
              <p id="erx-credentials-help" className="text-sm text-muted-foreground">
                {t('settings.credentials.help')}
              </p>
            </div>
            <div>
              <Button type="submit" loading={save.isPending} disabled={credentials.trim() === ''}>
                {t('settings.credentials.submit')}
              </Button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
