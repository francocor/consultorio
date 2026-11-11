import type { FiscalConfigResponse, InvoicingBlockReason } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../../app/guards.js';
import { useApi } from '../../../app/providers.js';
import { SimulatedBillingNotice } from '../../../app/SimulatedBillingNotice.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Switch } from '../../../shared/ui/checkbox.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { invoicingApi, invoicingKeys } from '../api/invoicing-api.js';

import { CredentialSection } from './CredentialSection.js';
import { PointsOfSaleSection } from './PointsOfSaleSection.js';
import { ProfileSection } from './ProfileSection.js';

/** Settings > Facturacion: the fiscal identity, the points of sale and the certificate. Owners and administrators. */
export function InvoicingSettingsPage() {
  return (
    <RequirePermission anyOf={['invoicing.configure']}>
      <Invoicing />
    </RequirePermission>
  );
}

function Invoicing() {
  const { t } = useTranslation('invoicing');
  usePageTitle(t('title'));
  const api = useApi();
  const config = useQuery({
    queryKey: invoicingKeys.config,
    queryFn: () => invoicingApi(api).config(),
  });

  if (config.isPending) return <FormSkeleton fields={4} />;
  if (config.isError) {
    return (
      <ErrorState
        error={config.error}
        onRetry={() => {
          void config.refetch();
        }}
      />
    );
  }
  return <InvoicingForms config={config.data} />;
}

function InvoicingForms({ config }: { config: FiscalConfigResponse }) {
  const { t } = useTranslation('invoicing');
  return (
    <div className="grid max-w-3xl gap-4">
      <SimulatedBillingNotice />
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Readiness readiness={config.readiness} />
      <EnableSection enabled={config.enabled} />
      <ProfileSection profile={config.profile} />
      <PointsOfSaleSection points={config.pointsOfSale} simulated={config.readiness.simulated} />
      <CredentialSection
        credential={config.credential}
        hasProfile={config.profile !== null}
        simulated={config.readiness.simulated}
      />
    </div>
  );
}

function Readiness({ readiness }: { readiness: FiscalConfigResponse['readiness'] }) {
  const { t } = useTranslation('invoicing');
  const reasons: readonly InvoicingBlockReason[] = readiness.reasons;
  return (
    <section aria-labelledby="readiness-title" className="grid gap-2 rounded-lg border bg-card p-4">
      <h3 id="readiness-title" className="font-medium">
        {t('readiness.title')}
      </h3>
      {readiness.available ? (
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden="true" />
          {t('readiness.available')}
        </p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm">
            <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
            {t('readiness.blocked')}
          </p>
          <ul className="ml-6 grid list-disc gap-1 text-sm">
            {reasons.map((reason) => (
              <li key={reason}>{t(`readiness.reason.${reason}`)}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function EnableSection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation('invoicing');
  const api = useApi();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (on: boolean) => invoicingApi(api).setEnabled(on),
    onSuccess: async () => {
      toast.success(t('enable.saved'));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: invoicingKeys.config }),
        queryClient.invalidateQueries({ queryKey: invoicingKeys.settings }),
      ]);
    },
  });

  return (
    <section aria-labelledby="enable-title" className="grid gap-3 rounded-lg border bg-card p-4">
      {toggle.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, toggle.error).message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-0.5">
          <h3 id="enable-title" className="font-medium">
            {t('enable.title')}
          </h3>
          <p id="enable-description" className="text-sm text-muted-foreground">
            {t('enable.description')}
          </p>
          <p id="enable-switch-label" className="mt-1 text-sm font-medium">
            {t('enable.switch')}
          </p>
        </div>
        <Switch
          aria-labelledby="enable-switch-label"
          aria-describedby="enable-description"
          checked={enabled}
          disabled={toggle.isPending}
          onCheckedChange={(on) => {
            toggle.mutate(on);
          }}
        />
      </div>
    </section>
  );
}
