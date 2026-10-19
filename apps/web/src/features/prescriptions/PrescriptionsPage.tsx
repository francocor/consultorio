import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { prescriptionKeys, prescriptionsApi } from './api/prescriptions-api.js';
import { CapabilityNotice } from './components/CapabilityNotice.js';
import { PrescriptionList } from './components/PrescriptionList.js';
import { SimulatedPrescriptionNotice } from './components/SimulatedPrescriptionNotice.js';

/**
 * The screen of the professional's prescriptions (`/prescriptions`): the ones they wrote across their
 * patients, newest first, with where each stands. A prescription is issued from the record of the
 * patient it is for; this screen is where to follow them, retry what waited for the provider and
 * cancel a mistake.
 */
export function PrescriptionsPage() {
  const { t } = useTranslation('prescriptions');
  usePageTitle(t('title'));
  const api = useApi();
  const capability = useQuery({
    queryKey: prescriptionKeys.capability,
    queryFn: () => prescriptionsApi(api).capability(),
  });
  const list = useQuery({
    queryKey: prescriptionKeys.mine,
    queryFn: () => prescriptionsApi(api).mine(),
  });

  return (
    <div>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="grid gap-4">
        <SimulatedPrescriptionNotice />
        {capability.data ? <CapabilityNotice capability={capability.data} /> : null}
        {list.isPending ? <FormSkeleton fields={3} /> : null}
        {list.isError ? (
          <ErrorState
            error={list.error}
            onRetry={() => {
              void list.refetch();
            }}
          />
        ) : null}
        {list.data ? (
          <PrescriptionList
            prescriptions={list.data.prescriptions}
            professionalId={capability.data?.professionalId ?? null}
            showPatient
          />
        ) : null}
      </div>
    </div>
  );
}
