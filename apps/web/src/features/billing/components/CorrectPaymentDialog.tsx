import {
  PAYMENT_METHODS,
  type Money,
  type PaymentDto,
  type PaymentMethod,
} from '@consultorio/contracts';
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
import { Select, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { MoneyInput } from '../../../shared/ui/money-input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingApi, billingKeys } from '../api/billing-api.js';
import { createSubmissionKeys } from '../domain/submission-key.js';

import { ErrorAlert } from './ErrorAlert.js';

/**
 * Corrects a payment that was recorded wrong, also after its register closed (billing-payments,
 * "Closed register immutability"): what is left of it is reversed and the right amount is entered as
 * a new payment, both in the register that is open, linked to the original. The closed register is
 * not touched.
 */
export function CorrectPaymentDialog({
  payment,
  onClose,
}: {
  payment: PaymentDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['billing', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const keys = useRef(createSubmissionKeys()).current;
  const [amount, setAmount] = useState<Money | null>(payment.netCents);
  const [method, setMethod] = useState<PaymentMethod>(payment.method);
  const [reason, setReason] = useState('');

  const valid = amount !== null && amount > 0 && reason.trim().length >= 3;
  const correct = useMutation({
    mutationFn: () => {
      if (amount === null) throw new Error('the amount is missing');
      return billingApi(api).correct(payment.id, {
        amountCents: amount,
        reason: reason.trim(),
        method,
        idempotencyKey: keys.keyFor(`${String(amount)}|${method}|${reason.trim()}`),
      });
    },
    onSuccess: async () => {
      keys.done();
      toast.success(t('billing:correct.done'));
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
          <DialogTitle>{t('billing:correct.title')}</DialogTitle>
          <DialogDescription>
            {t('billing:correct.description', { amount: formatMoney(payment.netCents) })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!correct.isPending && valid) correct.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="correct-amount">{t('billing:correct.amount')}</Label>
            <MoneyInput id="correct-amount" value={amount} onValueChange={setAmount} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="correct-method">{t('billing:payment.method')}</Label>
            <Select
              id="correct-method"
              value={method}
              onChange={(event) => {
                setMethod(event.target.value as PaymentMethod);
              }}
            >
              {PAYMENT_METHODS.map((option) => (
                <option key={option} value={option}>
                  {t(`billing:method.${option}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="correct-reason">{t('billing:correct.reason')}</Label>
            <Textarea
              id="correct-reason"
              value={reason}
              maxLength={200}
              rows={3}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>
          <ErrorAlert error={correct.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={correct.isPending} disabled={!valid}>
              {t('billing:correct.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
