import type { PatientDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Pencil, RotateCcw, UserRoundX } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { SlotOutlet } from '../../../app/slots.js';
import { formatAge, formatCalendarDay } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogDestructiveAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui/alert-dialog.js';
import { Button } from '../../../shared/ui/button.js';
import { SafetyFlag } from '../../../shared/ui/states/safety-flag.js';
import { StatusBadge } from '../../../shared/ui/states/status-badge.js';
import { toast } from '../../../shared/ui/toaster.js';
import { patientKeys, patientsApi } from '../api/patients-api.js';

import { documentText, initialsOf } from './PatientRow.js';

export function fullNameOf(patient: Pick<PatientDto, 'givenNames' | 'familyName'>): string {
  return `${patient.givenNames} ${patient.familyName}`;
}

/**
 * Who the patient is at a glance, and what can be done to the record. The safety indicator is
 * always the "see professional" summary here; the detail lives in the clinical tab.
 */
export function PatientHeader({
  patient,
  canEdit,
  canAdminister,
  onEdit,
}: {
  patient: PatientDto;
  canEdit: boolean;
  canAdminister: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation(['patients', 'common']);
  const document = documentText(patient.document);
  const age = formatAge(patient.birthDate);
  const inactive = patient.status === 'inactive';

  return (
    <header className="mb-6 grid gap-4">
      <Link
        to="/patients"
        className="link-target inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t('patients:detail.back')}
      </Link>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden="true"
            className="grid size-14 shrink-0 place-content-center rounded-full bg-accent font-display text-lg font-semibold text-accent-foreground"
          >
            {initialsOf(patient.familyName, patient.givenNames)}
          </span>
          <div className="grid min-w-0 gap-1.5">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {fullNameOf(patient)}
            </h1>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
              {age ? <span>{age}</span> : null}
              <span>
                {t('patients:detail.born', { date: formatCalendarDay(patient.birthDate) })}
              </span>
              <span className="tabular">{document ?? t('patients:row.noDocument')}</span>
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {inactive ? <StatusBadge status="inactive" /> : null}
              <SafetyFlag
                flags={patient.hasSafetyFlag ? ['allergy_on_file'] : []}
                detail="summary"
              />
              {patient.consentStatus === 'missing' ? (
                <StatusBadge status="warning">{t('patients:consent.missing')}</StatusBadge>
              ) : null}
              {patient.consentStatus === 'revoked' ? (
                <StatusBadge status="warning">{t('patients:consent.revoked')}</StatusBadge>
              ) : null}
              <SlotOutlet slot="patient-header" patientId={patient.id} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit ? (
            <Button variant="outline" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              {t('patients:detail.edit')}
            </Button>
          ) : null}
          {canAdminister ? <StatusToggle patient={patient} /> : null}
        </div>
      </div>
    </header>
  );
}

/** Deactivating asks first; reactivating is harmless and happens at once. Nobody is ever deleted. */
function StatusToggle({ patient }: { patient: PatientDto }) {
  const { t } = useTranslation(['patients', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const inactive = patient.status === 'inactive';

  const change = useMutation({
    mutationFn: () =>
      inactive ? patientsApi(api).reactivate(patient.id) : patientsApi(api).deactivate(patient.id),
    onSuccess: async () => {
      setConfirming(false);
      toast.success(t(inactive ? 'patients:detail.reactivated' : 'patients:detail.deactivated'));
      await queryClient.invalidateQueries({ queryKey: patientKeys.all });
    },
    onError: (error) => {
      setConfirming(false);
      toast.error(describeError(t, error).message);
    },
  });

  if (inactive) {
    return (
      <Button
        variant="outline"
        loading={change.isPending}
        onClick={() => {
          change.mutate();
        }}
      >
        <RotateCcw aria-hidden="true" />
        {t('patients:detail.reactivate')}
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setConfirming(true);
        }}
      >
        <UserRoundX aria-hidden="true" />
        {t('patients:detail.deactivate')}
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('patients:detail.deactivate.title', { name: fullNameOf(patient) })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('patients:detail.deactivate.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogDestructiveAction
              onClick={(event) => {
                event.preventDefault();
                change.mutate();
              }}
            >
              {t('patients:detail.deactivate.confirm')}
            </AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
