import type { PrescriptionDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { prescriptionKeys, prescriptionsApi } from '../api/prescriptions-api.js';

import { ErrorAlert } from './ErrorAlert.js';

const MIN_REASON = 3;

/**
 * Cancels a prescription with a mandatory reason (e-prescription, "Immutability and cancellation").
 * An issued prescription is cancelled THROUGH the provider: if it refuses, the prescription stays
 * issued and the dialog says why; if it cannot be reached, nothing changed and the same request can
 * be sent again. The prescription stays visible, with its reason.
 */
export function CancelPrescriptionDialog({
  prescription,
  onClose,
}: {
  prescription: PrescriptionDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['prescriptions', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= MIN_REASON;
  const issued = prescription.status === 'issued';

  const cancel = useMutation({
    mutationFn: () => prescriptionsApi(api).cancel(prescription.id, { reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(t('prescriptions:cancel.done'));
      await queryClient.invalidateQueries({ queryKey: prescriptionKeys.all });
      onClose();
    },
    // The prescription may have changed under the dialog (settled by the provider): show how it is now.
    onError: () => queryClient.invalidateQueries({ queryKey: prescriptionKeys.all }),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('prescriptions:cancel.title')}</DialogTitle>
          <DialogDescription>
            {issued
              ? t('prescriptions:cancel.descriptionIssued')
              : t('prescriptions:cancel.descriptionPending')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!cancel.isPending && valid) cancel.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="cancel-reason">{t('prescriptions:cancel.reason')}</Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              maxLength={300}
              rows={3}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>
          <ErrorAlert error={cancel.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.back')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={cancel.isPending}
              disabled={!valid}
            >
              {t('prescriptions:cancel.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
