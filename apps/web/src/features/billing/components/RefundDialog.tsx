import type { Money, PaymentDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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
import { MoneyInput } from '../../../shared/ui/money-input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingApi, billingKeys } from '../api/billing-api.js';
import { createSubmissionKeys } from '../domain/submission-key.js';

import { ErrorAlert } from './ErrorAlert.js';

/**
 * Gives back part or all of what is left of a payment, with a reason. The payment is not edited:
 * the refund is an entry of its own, linked to it (billing-payments, "Refunds and payment
 * reversals"). Cash leaves the open register of the place.
 */
export function RefundDialog({ payment, onClose }: { payment: PaymentDto; onClose: () => void }) {
  const { t } = useTranslation(['billing', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const keys = useRef(createSubmissionKeys()).current;
  const [amount, setAmount] = useState<Money | null>(payment.netCents);
  const [reason, setReason] = useState('');

  const valid =
    amount !== null && amount > 0 && amount <= payment.netCents && reason.trim().length >= 3;
  const refund = useMutation({
    mutationFn: () => {
      if (amount === null) throw new Error('the amount is missing');
      return billingApi(api).refund(payment.id, {
        amountCents: amount,
        reason: reason.trim(),
        idempotencyKey: keys.keyFor(`${String(amount)}|${reason.trim()}`),
      });
    },
    onSuccess: async () => {
      keys.done();
      toast.success(t('billing:refund.done'));
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
          <DialogTitle>{t('billing:refund.title')}</DialogTitle>
          <DialogDescription>
            {t('billing:refund.description', {
              method: t(`billing:method.${payment.method}`),
              amount: formatMoney(payment.netCents),
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!refund.isPending && valid) refund.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="refund-amount">{t('billing:refund.amount')}</Label>
            <MoneyInput
              id="refund-amount"
              value={amount}
              onValueChange={setAmount}
              max={payment.netCents}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="refund-reason">{t('billing:refund.reason')}</Label>
            <Textarea
              id="refund-reason"
              value={reason}
              maxLength={200}
              rows={3}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>
          <ErrorAlert error={refund.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={refund.isPending}
              disabled={!valid}
            >
              {t('billing:refund.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
