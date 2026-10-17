import type { WorklistItemDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { Button } from '../../../shared/ui/button.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { ErrorNotice } from '../../calendar/components/drawer/ErrorNotice.js';
import { worklistApi, worklistKeys } from '../api/worklist-api.js';

/**
 * Confirming the identity of the patient of an appointment: the staff member says they saw the
 * patient and the ID document. The API refuses the appointment's own professional (403), and the
 * dialog says so. The version sent is the one the card was listed with, so a stale screen cannot
 * confirm over a change somebody else made: the API answers 409 and the list is read again.
 */
export function ConfirmIdentityDialog({
  item,
  onClose,
}: {
  item: WorklistItemDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [seen, setSeen] = useState(false);

  const confirm = useMutation({
    mutationFn: async () => {
      if (!item.appointment) throw new Error('only an appointment has an identity to confirm');
      return worklistApi(api).confirmIdentity(item.id, item.appointment.version);
    },
    onSuccess: async () => {
      toast.success(t('scheduling:worklist.confirmIdentity.done'));
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

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('scheduling:worklist.confirmIdentity.title')}</DialogTitle>
          <DialogDescription>
            {t('scheduling:worklist.confirmIdentity.description', {
              patient: item.appointment?.patientName ?? '',
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2">
          <Checkbox
            id="confirm-identity-seen"
            checked={seen}
            onCheckedChange={(value) => {
              setSeen(value === true);
            }}
          />
          <Label htmlFor="confirm-identity-seen" className="font-normal leading-snug">
            {t('scheduling:worklist.confirmIdentity.seen')}
          </Label>
        </div>
        {confirm.isError ? <ErrorNotice error={confirm.error} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common:action.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!seen}
            loading={confirm.isPending}
            onClick={() => {
              confirm.mutate();
            }}
          >
            {t('scheduling:worklist.confirmIdentity.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
