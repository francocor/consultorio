import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { Button } from '../../shared/ui/button.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { prescriptionKeys, prescriptionsApi } from './api/prescriptions-api.js';
import { CapabilityNotice } from './components/CapabilityNotice.js';
import { IssuePrescriptionDialog } from './components/IssuePrescriptionDialog.js';
import { PrescriptionList } from './components/PrescriptionList.js';
import { SimulatedPrescriptionNotice } from './components/SimulatedPrescriptionNotice.js';

const NOTICE_ID = 'prescriptions-capability';

/**
 * The prescriptions tab of the patient record (`patient-detail-tab`, which hands it `patientId`):
 * the prescriptions of the patient that this professional may read, the button to issue another, and
 * the reason it cannot be used when it cannot (the provider is not connected, the matricula is not
 * verified). Only professionals see the tab.
 */
export function PatientPrescriptionsTab({ patientId }: { patientId: string }) {
  const { t } = useTranslation('prescriptions');
  const api = useApi();
  const [issuing, setIssuing] = useState(false);
  const capability = useQuery({
    queryKey: prescriptionKeys.capability,
    queryFn: () => prescriptionsApi(api).capability(),
  });
  const list = useQuery({
    queryKey: prescriptionKeys.patient(patientId),
    queryFn: () => prescriptionsApi(api).forPatient(patientId),
  });

  if (list.isPending || capability.isPending) return <FormSkeleton fields={3} />;
  if (list.isError || capability.isError) {
    return (
      <ErrorState
        error={list.error ?? capability.error}
        onRetry={() => {
          void list.refetch();
          void capability.refetch();
        }}
      />
    );
  }
  const can = capability.data.canIssue;

  return (
    <div className="grid gap-4">
      <SimulatedPrescriptionNotice />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">{t('patientTab.title')}</h2>
        <Button
          type="button"
          disabled={!can}
          aria-describedby={can ? undefined : NOTICE_ID}
          onClick={() => {
            setIssuing(true);
          }}
        >
          <Plus aria-hidden="true" />
          {t('action.issue')}
        </Button>
      </div>
      <CapabilityNotice capability={capability.data} id={NOTICE_ID} />
      <PrescriptionList
        prescriptions={list.data.prescriptions}
        professionalId={capability.data.professionalId}
      />
      {issuing ? (
        <IssuePrescriptionDialog
          patientId={patientId}
          onClose={() => {
            setIssuing(false);
          }}
        />
      ) : null}
    </div>
  );
}
