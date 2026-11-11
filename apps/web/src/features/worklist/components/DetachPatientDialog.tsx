import {
  CANCELLATION_REASONS,
  CANCELLED_BY,
  type CancellationReason,
  type CancelledBy,
  type PatientSummaryDto,
  type WorklistItemDto,
} from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { ErrorNotice } from '../../calendar/components/drawer/ErrorNotice.js';
import { PatientPicker } from '../../patients/components/PatientPicker.js';
import { worklistApi, worklistKeys } from '../api/worklist-api.js';

type Choice = 'move' | 'cancel';

/** What the dialog decides; the version comes from the card the action was opened on. */
type DetachPatientBody =
  | { resolution: 'move_to_patient'; patientId: string }
  | {
      resolution: 'cancel';
      cancelledBy: CancelledBy;
      reasonCode: CancellationReason;
    };

/**
 * The match with the patient was wrong. The appointment either goes to the right patient record or
 * is cancelled; the record that was matched is left exactly as it was.
 */
export function DetachPatientDialog({
  item,
  onClose,
}: {
  item: WorklistItemDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<Choice>('move');
  const [patient, setPatient] = useState<PatientSummaryDto | null>(null);
  const [by, setBy] = useState<CancelledBy | ''>('');
  const [reason, setReason] = useState<CancellationReason | ''>('');

  const detach = useMutation({
    mutationFn: async (body: DetachPatientBody) => {
      if (!item.appointment) throw new Error('only an appointment has a patient to correct');
      return worklistApi(api).detachPatient(item.appointment.id, {
        ...body,
        expectedVersion: item.appointment.version,
      });
    },
    onSuccess: async () => {
      toast.success(t('scheduling:worklist.detach.done'));
      await queryClient.invalidateQueries({ queryKey: worklistKeys.all });
      await queryClient.invalidateQueries({ queryKey: ['calendar'] });
      onClose();
    },
    onError: async (error) => {
      if (isApiError(error) && error.code === 'stale_revision') {
        await queryClient.invalidateQueries({ queryKey: worklistKeys.all });
      }
    },
  });

  const ready = choice === 'move' ? patient !== null : by !== '' && reason !== '';

  function apply() {
    if (choice === 'move' && patient) {
      detach.mutate({ resolution: 'move_to_patient', patientId: patient.id });
    } else if (choice === 'cancel' && by !== '' && reason !== '') {
      detach.mutate({ resolution: 'cancel', cancelledBy: by, reasonCode: reason });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('scheduling:worklist.detach.title')}</DialogTitle>
          <DialogDescription>{t('scheduling:worklist.detach.description')}</DialogDescription>
        </DialogHeader>

        <div
          role="radiogroup"
          aria-label={t('scheduling:worklist.detach.choice')}
          className="grid gap-2"
        >
          {(['move', 'cancel'] as const).map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm"
            >
              <input
                type="radio"
                name="detach-choice"
                checked={choice === option}
                onChange={() => {
                  setChoice(option);
                }}
                className="size-4"
              />
              {t(`scheduling:worklist.detach.option.${option}`)}
            </label>
          ))}
        </div>

        {choice === 'move' ? (
          patient ? (
            <div className="flex items-center justify-between gap-2 rounded-md border bg-card px-3 py-2">
              <span className="font-medium">{`${patient.familyName}, ${patient.givenNames}`}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPatient(null);
                }}
              >
                {t('scheduling:booking.changePatient')}
              </Button>
            </div>
          ) : (
            <PatientPicker label={t('scheduling:worklist.detach.patient')} onSelect={setPatient} />
          )
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="detach-by">{t('scheduling:drawer.cancel.by')}</Label>
              <Select
                id="detach-by"
                value={by}
                onChange={(event) => {
                  setBy(event.target.value as CancelledBy | '');
                }}
              >
                <option value="" />
                {CANCELLED_BY.map((option) => (
                  <option key={option} value={option}>
                    {t(`scheduling:drawer.cancel.byOption.${option}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="detach-reason">{t('scheduling:drawer.cancel.reason')}</Label>
              <Select
                id="detach-reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value as CancellationReason | '');
                }}
              >
                <option value="" />
                {CANCELLATION_REASONS.map((option) => (
                  <option key={option} value={option}>
                    {t(`scheduling:drawer.cancel.reasonOption.${option}`)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        )}

        {detach.isError ? <ErrorNotice error={detach.error} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common:action.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!ready}
            variant={choice === 'cancel' ? 'destructive' : 'default'}
            loading={detach.isPending}
            onClick={apply}
          >
            {t(`scheduling:worklist.detach.apply.${choice}`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
