import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, FileX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { cn } from '../../shared/lib/cn.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { buttonVariants } from '../../shared/ui/button.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { DetailSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { patientKeys, patientsApi } from '../patients/api/patients-api.js';
import { fullNameOf } from '../patients/components/PatientHeader.js';

import { clinicalApi, clinicalKeys } from './api/clinical-api.js';
import { ClinicalEditor } from './components/ClinicalEditor.js';
import { NoteView } from './components/NoteView.js';

export function NotePage() {
  const params: unknown = useParams({ strict: false });
  const noteId =
    typeof params === 'object' && params !== null && 'noteId' in params
      ? String(params.noteId)
      : '';
  return <NoteScreen noteId={noteId} />;
}

/**
 * One clinical note. A draft its author can still change opens in the editor; anything else (a
 * signed note, a colleague's note, a draft in a read-only organization) opens as a read.
 */
function NoteScreen({ noteId }: { noteId: string }) {
  const { t } = useTranslation(['clinical', 'common', 'patients']);
  const api = useApi();
  const queryClient = useQueryClient();

  const note = useQuery({
    queryKey: clinicalKeys.note(noteId),
    queryFn: () => clinicalApi(api).note(noteId),
    // A refusal is an answer, and every open of a note is an audited read: no retries, no cache.
    retry: false,
    gcTime: 0,
  });
  const patientId = note.data?.patientId ?? '';
  const patient = useQuery({
    queryKey: patientKeys.detail(patientId),
    queryFn: () => patientsApi(api).get(patientId),
    enabled: patientId !== '',
  });
  const patientName = patient.data ? fullNameOf(patient.data) : null;
  usePageTitle(patientName ?? t('clinical:editor.page'));

  if (note.isPending) return <DetailSkeleton />;
  if (note.isError) {
    if (isApiError(note.error) && (note.error.status === 404 || note.error.status === 403)) {
      return (
        <EmptyState
          icon={FileX}
          title={t('clinical:editor.notFound.title')}
          description={t('clinical:editor.notFound.description')}
          action={
            <Link to="/patients" className={cn(buttonVariants())}>
              {t('patients:detail.back')}
            </Link>
          }
        />
      );
    }
    return (
      <ErrorState
        error={note.error}
        onRetry={() => {
          void note.refetch();
        }}
      />
    );
  }

  const current = note.data;
  const editable = current.status === 'draft' && current.access.canEdit;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        to="/patients/$patientId"
        params={{ patientId: current.patientId }}
        search={{ tab: 'chart' }}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'mb-3 -ml-3 gap-1')}
      >
        <ArrowLeft aria-hidden="true" />
        {t('clinical:editor.back')}
      </Link>
      <PageHeader
        title={patientName ?? t('clinical:editor.page')}
        description={t(`clinical:template.${current.templateKind}`)}
      />
      {current.status === 'draft' && !current.access.canEdit ? (
        <Alert tone="warning" className="mb-4">
          <AlertDescription className="grid gap-1">
            <p className="font-medium">{t('clinical:editor.readOnly.title')}</p>
            <p>{t('clinical:editor.readOnly.description')}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {editable ? (
        <ClinicalEditor
          key={current.id}
          note={current}
          onNote={(next) => {
            queryClient.setQueryData(clinicalKeys.note(noteId), next);
            if (next.status !== 'draft') {
              void queryClient.invalidateQueries({
                queryKey: clinicalKeys.timelineOf(next.patientId),
              });
              void queryClient.invalidateQueries({ queryKey: clinicalKeys.drafts });
              void queryClient.invalidateQueries({
                queryKey: clinicalKeys.odontogram(next.patientId),
              });
            }
          }}
        />
      ) : (
        <NoteView note={current} />
      )}
    </div>
  );
}
