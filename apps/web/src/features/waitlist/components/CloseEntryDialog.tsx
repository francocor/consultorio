import type { WaitlistEntryDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { toast } from '../../../shared/ui/toaster.js';
import { waitlistApi, waitlistKeys } from '../api/waitlist-api.js';

type Reason = 'fulfilled' | 'cancelled';

/**
 * Closes an entry with the reason: the patient already has a turn, or no longer wants one. The
 * entry stays in the list of closed ones for the reports; it is never deleted.
 */
export function CloseEntryDialog({
  entry,
  onClose,
  initialReason = 'cancelled',
}: {
  entry: WaitlistEntryDto;
  onClose: () => void;
  initialReason?: Reason;
}) {
  const { t } = useTranslation(['waitlist', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<Reason>(initialReason);

  const close = useMutation({
    mutationFn: () => waitlistApi(api).close(entry.id, { reason }),
    onSuccess: async () => {
      toast.success(t('waitlist:close.done'));
      await queryClient.invalidateQueries({ queryKey: waitlistKeys.all });
      onClose();
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
          <DialogTitle>{t('waitlist:close.title', { name: entry.patientName })}</DialogTitle>
          <DialogDescription>{t('waitlist:close.description')}</DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label={t('waitlist:close.reason')} className="grid gap-2">
          {(['fulfilled', 'cancelled'] as const).map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm"
            >
              <input
                type="radio"
                name="close-reason"
                checked={reason === option}
                onChange={() => {
                  setReason(option);
                }}
                className="size-4"
              />
              {t(`waitlist:close.option.${option}`)}
            </label>
          ))}
        </div>

        {close.isError ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, close.error).message}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common:action.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={close.isPending}
            onClick={() => {
              close.mutate();
            }}
          >
            {t('waitlist:close.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
