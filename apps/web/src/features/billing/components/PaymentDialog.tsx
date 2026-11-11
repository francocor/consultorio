import {
  PAYMENT_METHODS,
  type ChargeDto,
  type Money,
  type PaymentMethod,
} from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatMoney } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
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
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { MoneyInput } from '../../../shared/ui/money-input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingApi, billingKeys } from '../api/billing-api.js';
import { paymentDraft } from '../domain/payment-form.js';
import { createSubmissionKeys } from '../domain/submission-key.js';

import { ErrorAlert } from './ErrorAlert.js';

/**
 * Records a payment of the patient against a charge. The amount starts at what is owed; a part is
 * a partial payment; more than is owed needs the credit balance confirmed. Every submission carries
 * a key made for it: pressing twice, or retrying after the connection dropped, sends the SAME key and
 * the server records one payment (billing-payments, "Duplicate payment protection").
 */
export function PaymentDialog({ charge, onClose }: { charge: ChargeDto; onClose: () => void }) {
  const { t } = useTranslation(['billing', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const keys = useRef(createSubmissionKeys()).current;

  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [amount, setAmount] = useState<Money | null>(charge.outstandingCents);
  const [reference, setReference] = useState('');
  const [confirmCredit, setConfirmCredit] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [repeatedVoucher, setRepeatedVoucher] = useState(false);

  const draft = paymentDraft({ outstanding: charge.outstandingCents, amount, method });
  const typedReference = draft.asksReference ? reference.trim() : '';

  const pay = useMutation({
    mutationFn: () => {
      if (amount === null) throw new Error('the amount is missing');
      const signature = [method, amount, typedReference, confirmCredit, overrideReason.trim()].join(
        '|',
      );
      return billingApi(api).pay(charge.id, {
        method,
        amountCents: amount,
        idempotencyKey: keys.keyFor(signature),
        ...(typedReference === '' ? {} : { externalRef: typedReference }),
        ...(confirmCredit ? { confirmCredit: true } : {}),
        ...(repeatedVoucher && overrideReason.trim() !== ''
          ? { overrideReason: overrideReason.trim() }
          : {}),
      });
    },
    onSuccess: async () => {
      keys.done();
      toast.success(t('billing:payment.done'));
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
      onClose();
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'payment_voucher_duplicate') setRepeatedVoucher(true);
    },
  });

  const submit = () => {
    // A second press while the first is on its way does nothing.
    if (pay.isPending || !draft.canSubmit) return;
    if (draft.needsCreditConfirmation && !confirmCredit) return;
    pay.mutate();
  };

  const needsRegister = isApiError(pay.error) && pay.error.code === 'cash_register_required';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('billing:payment.title')}</DialogTitle>
          <DialogDescription>
            {t('billing:payment.owed', {
              patient: charge.patientName,
              amount: formatMoney(charge.outstandingCents),
            })}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="payment-method">{t('billing:payment.method')}</Label>
            <Select
              id="payment-method"
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
            <Label htmlFor="payment-amount">{t('billing:payment.amount')}</Label>
            <MoneyInput
              id="payment-amount"
              value={amount}
              onValueChange={setAmount}
              aria-describedby="payment-remaining"
            />
            <p id="payment-remaining" className="text-sm text-muted-foreground">
              {draft.excess > 0
                ? t('billing:payment.excess', { amount: formatMoney(draft.excess) })
                : t('billing:payment.remaining', { amount: formatMoney(draft.remaining) })}
            </p>
          </div>

          {draft.needsCreditConfirmation ? (
            <div className="flex items-start gap-2 rounded-md border bg-card p-3">
              <Checkbox
                id="payment-credit"
                checked={confirmCredit}
                onCheckedChange={(next) => {
                  setConfirmCredit(next === true);
                }}
              />
              <Label htmlFor="payment-credit" className="font-normal">
                {t('billing:payment.confirmCredit', { amount: formatMoney(draft.excess) })}
              </Label>
            </div>
          ) : null}

          {draft.asksReference ? (
            <div className="grid gap-1.5">
              <Label htmlFor="payment-reference">{t('billing:payment.reference')}</Label>
              <Input
                id="payment-reference"
                value={reference}
                maxLength={64}
                autoComplete="off"
                onChange={(event) => {
                  setReference(event.target.value);
                }}
              />
              <p className="text-sm text-muted-foreground">{t('billing:payment.referenceHint')}</p>
            </div>
          ) : null}

          {repeatedVoucher ? (
            <div className="grid gap-1.5">
              <Alert tone="warning">
                <AlertDescription>{t('billing:payment.voucherRepeated')}</AlertDescription>
              </Alert>
              <Label htmlFor="payment-override">{t('billing:payment.overrideReason')}</Label>
              <Input
                id="payment-override"
                value={overrideReason}
                maxLength={200}
                onChange={(event) => {
                  setOverrideReason(event.target.value);
                }}
              />
            </div>
          ) : null}

          <ErrorAlert error={pay.error} />
          {needsRegister ? (
            <Link to="/cash" className="text-sm font-medium text-primary-ink underline">
              {t('billing:payment.openRegister')}
            </Link>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              loading={pay.isPending}
              disabled={
                !draft.canSubmit ||
                (draft.needsCreditConfirmation && !confirmCredit) ||
                (repeatedVoucher && overrideReason.trim().length < 3)
              }
            >
              {t('billing:payment.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
