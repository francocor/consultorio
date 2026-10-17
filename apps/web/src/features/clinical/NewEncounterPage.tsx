import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { DetailSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { patientKeys, patientsApi } from '../patients/api/patients-api.js';
import { fullNameOf } from '../patients/components/PatientHeader.js';

import { clinicalKeys } from './api/clinical-api.js';
import { NewEncounterForm } from './components/NewEncounterForm.js';

/**
 * `/encounters/new?patientId=&appointmentId=`: where the app takes a professional to start a
 * consultation. The agenda links here from an appointment, so the encounter is created already tied
 * to it; the patient's record links here without one.
 */
export function NewEncounterPage() {
  const { t } = useTranslation(['clinical', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search: { patientId?: string; appointmentId?: string } = useSearch({ strict: false });
  const patientId = search.patientId ?? '';
  usePageTitle(t('clinical:new.title'));

  const patient = useQuery({
    queryKey: patientKeys.detail(patientId),
    queryFn: () => patientsApi(api).get(patientId),
    enabled: patientId !== '',
  });

  if (patientId === '') {
    return (
      <EmptyState title={t('clinical:new.title')} description={t('clinical:new.patientMissing')} />
    );
  }
  if (patient.isPending) return <DetailSkeleton />;

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title={t('clinical:new.title')}
        description={
          patient.data
            ? `${fullNameOf(patient.data)}. ${t('clinical:new.description')}`
            : t('clinical:new.description')
        }
      />
      <NewEncounterForm
        patientId={patientId}
        appointmentId={search.appointmentId}
        onOpened={(note) => {
          queryClient.setQueryData(clinicalKeys.note(note.id), note);
          void navigate({ to: '/notes/$noteId', params: { noteId: note.id } });
        }}
        onCancel={() => {
          void navigate({
            to: '/patients/$patientId',
            params: { patientId },
            search: { tab: 'chart' },
          });
        }}
      />
    </div>
  );
}
