import type { ChargeDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatMoney } from '../../../shared/lib/format.js';
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
import { billingApi, billingKeys } from '../api/billing-api.js';

import { ErrorAlert } from './ErrorAlert.js';

/**
 * Voids a charge with a reason. The charge stays, visible and marked voided; it is never deleted.
 * With payments the server refuses (refund first), and with an issued invoice too (a credit note).
 */
export function VoidChargeDialog({ charge, onClose }: { charge: ChargeDto; onClose: () => void }) {
  const { t } = useTranslation(['billing', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 3;

  const voidIt = useMutation({
    mutationFn: () => billingApi(api).voidCharge(charge.id, { reason: reason.trim() }),
    onSuccess: async () => {
      toast.success(t('billing:void.done'));
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
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
          <DialogTitle>{t('billing:void.title', { patient: charge.patientName })}</DialogTitle>
          <DialogDescription>
            {t('billing:void.description', { amount: formatMoney(charge.totalCents) })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!voidIt.isPending && valid) voidIt.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="void-reason">{t('billing:void.reason')}</Label>
            <Textarea
              id="void-reason"
              value={reason}
              maxLength={200}
              rows={3}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>
          <ErrorAlert error={voidIt.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={voidIt.isPending}
              disabled={!valid}
            >
              {t('billing:void.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
