import {
  OPERATOR_BILLING_REASON_MAX,
  OPERATOR_BILLING_REASON_MIN,
  money,
  type OperatorPaymentDto,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate, formatMoney, parseMoney } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button, WRAPPING_LABEL } from '../../../shared/ui/button.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Input, Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';

import { operatorSubscriptionKeys, operatorSubscriptionsApi } from './subscriptions-api.js';

/** The reason the operator gives is read by the next person who looks at the case: it is never empty. */
const reasonIsValid = (reason: string) =>
  reason.trim().length >= OPERATOR_BILLING_REASON_MIN &&
  reason.trim().length <= OPERATOR_BILLING_REASON_MAX;

/**
 * A decision of the operator on billing: the reason in their own words, a confirmation, and the action.
 * The reason goes into the trail of the platform with the operator who gave it.
 */
function DecisionDialog({
  open,
  title,
  description,
  submit,
  pending,
  error,
  needsConfirmation,
  disabled = false,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  submit: string;
  pending: boolean;
  error: unknown;
  needsConfirmation: string | null;
  disabled?: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation(['subscription', 'common']);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const ready = reasonIsValid(reason) && (needsConfirmation === null || confirmed) && !disabled;
  const close = () => {
    setReason('');
    setConfirmed(false);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) onSubmit(reason.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, error).message}</AlertDescription>
            </Alert>
          ) : null}
          {children}
          <div className="grid gap-1.5">
            <Label htmlFor="billing-reason">{t('subscription:operator.decision.reason')}</Label>
            <Textarea
              id="billing-reason"
              value={reason}
              maxLength={OPERATOR_BILLING_REASON_MAX}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t('subscription:operator.decision.reasonHelp', { min: OPERATOR_BILLING_REASON_MIN })}
            </p>
          </div>
          {needsConfirmation === null ? null : (
            <div className="flex items-start gap-2">
              <Checkbox
                id="billing-confirm"
                checked={confirmed}
                onCheckedChange={(next) => {
                  setConfirmed(next === true);
                }}
              />
              <Label htmlFor="billing-confirm" className="text-sm leading-snug">
                {needsConfirmation}
              </Label>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={pending} disabled={!ready}>
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Let it go": the operator looked at what the provider holds and decided. */
export function ResolveParkedButton({ tenantId, name }: { tenantId: string; name: string }) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const resolve = useMutation({
    mutationFn: (reason: string) => operatorSubscriptionsApi(api).resolveParked(tenantId, reason),
    onSuccess: async () => {
      toast.success(t('operator.resolve.done', { name }));
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: operatorSubscriptionKeys.list });
    },
  });
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={WRAPPING_LABEL}
        aria-label={t('operator.resolve.openLabel', { name })}
        onClick={() => {
          resolve.reset();
          setOpen(true);
        }}
      >
        {t('operator.resolve.open')}
      </Button>
      <DecisionDialog
        open={open}
        title={t('operator.resolve.title', { name })}
        description={t('operator.resolve.description')}
        submit={t('operator.resolve.submit')}
        pending={resolve.isPending}
        error={resolve.error}
        needsConfirmation={t('operator.resolve.confirm')}
        onClose={() => {
          setOpen(false);
        }}
        onSubmit={(reason) => {
          resolve.mutate(reason);
        }}
      />
    </>
  );
}

/** The payment being refunded and the token made when the operator opened the confirmation. */
interface RefundRequest {
  payment: OperatorPaymentDto;
  token: string;
}

function RefundDialog({
  tenantId,
  request,
  onClose,
}: {
  tenantId: string;
  request: RefundRequest | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const queryClient = useQueryClient();
  const payment = request?.payment ?? null;
  const left = payment ? payment.amountCents - payment.refundedCents : 0;
  const [amount, setAmount] = useState('');
  // The token of this confirmation travels with every click and every retry, and the server makes one
  // refund however many times it hears it.
  const cents = amount.trim() === '' ? left : (parseMoney(amount) ?? 0);
  const valid = payment !== null && cents > 0 && cents <= left;

  const refund = useMutation({
    mutationFn: (reason: string) => {
      if (!request) throw new Error('no payment selected');
      return operatorSubscriptionsApi(api).refund(tenantId, request.payment.id, {
        amountCents: cents,
        reason,
        token: request.token,
      });
    },
    onSuccess: async () => {
      toast.success(t('operator.refund.done', { amount: formatMoney(money(cents)) }));
      setAmount('');
      onClose();
      await queryClient.invalidateQueries({
        queryKey: operatorSubscriptionKeys.payments(tenantId),
      });
      await queryClient.invalidateQueries({ queryKey: operatorSubscriptionKeys.list });
    },
  });

  return (
    <DecisionDialog
      open={request !== null}
      title={t('operator.refund.title')}
      description={t('operator.refund.description', { left: formatMoney(money(left)) })}
      submit={t('operator.refund.submit')}
      pending={refund.isPending}
      error={refund.error}
      needsConfirmation={t('operator.refund.confirm', { amount: formatMoney(money(cents)) })}
      disabled={!valid}
      onClose={() => {
        refund.reset();
        setAmount('');
        onClose();
      }}
      onSubmit={(reason) => {
        refund.mutate(reason);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="billing-refund-amount">{t('operator.refund.amount')}</Label>
        <Input
          id="billing-refund-amount"
          inputMode="decimal"
          value={amount}
          placeholder={formatMoney(money(left))}
          aria-invalid={!valid}
          onChange={(event) => {
            setAmount(event.target.value);
          }}
        />
      </div>
    </DecisionDialog>
  );
}

function ReviewDialog({
  tenantId,
  payment,
  onClose,
}: {
  tenantId: string;
  payment: OperatorPaymentDto | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const queryClient = useQueryClient();
  const review = useMutation({
    mutationFn: (reason: string) => {
      if (!payment) throw new Error('no payment selected');
      return operatorSubscriptionsApi(api).review(tenantId, payment.id, reason);
    },
    onSuccess: async () => {
      toast.success(t('operator.review.done'));
      onClose();
      await queryClient.invalidateQueries({
        queryKey: operatorSubscriptionKeys.payments(tenantId),
      });
      await queryClient.invalidateQueries({ queryKey: operatorSubscriptionKeys.list });
    },
  });
  return (
    <DecisionDialog
      open={payment !== null}
      title={t('operator.review.title')}
      description={t('operator.review.description')}
      submit={t('operator.review.submit')}
      pending={review.isPending}
      error={review.error}
      needsConfirmation={null}
      onClose={() => {
        review.reset();
        onClose();
      }}
      onSubmit={(reason) => {
        review.mutate(reason);
      }}
    />
  );
}

/** The payments of an organization, with what the operator may do about each: refund it, mark it looked at. */
export function PaymentsPanel({ tenantId, name }: { tenantId: string; name: string }) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const [refunding, setRefunding] = useState<RefundRequest | null>(null);
  const [reviewing, setReviewing] = useState<OperatorPaymentDto | null>(null);
  const payments = useQuery({
    queryKey: operatorSubscriptionKeys.payments(tenantId),
    queryFn: () => operatorSubscriptionsApi(api).payments(tenantId),
  });

  return (
    <section
      aria-label={t('operator.payments.title', { name })}
      className="grid gap-2 border-t pt-3"
    >
      <h3 className="text-sm font-medium">{t('operator.payments.title', { name })}</h3>
      {payments.isPending ? <ListSkeleton rows={2} /> : null}
      {payments.isError ? (
        <ErrorState
          error={payments.error}
          onRetry={() => {
            void payments.refetch();
          }}
        />
      ) : null}
      {payments.isSuccess && payments.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('operator.payments.none')}</p>
      ) : null}
      {payments.isSuccess && payments.data.length > 0 ? (
        <ul className="grid gap-2">
          {payments.data.map((payment) => {
            const left = payment.amountCents - payment.refundedCents;
            const refundable =
              (payment.status === 'approved' || payment.status === 'partially_refunded') &&
              left > 0;
            const unreviewed = payment.surplus && payment.surplusReviewedAt === null;
            return (
              <li key={payment.id} className="grid gap-1 rounded-md border p-2 text-sm">
                <p className="break-words">
                  {t('operator.payments.row', {
                    date: formatDate(payment.createdAt),
                    purpose: t(`operator.payments.purpose.${payment.purpose}`),
                    amount: formatMoney(money(payment.amountCents)),
                    status: payment.status,
                  })}
                </p>
                {payment.refundedCents > 0 ? (
                  <p className="text-muted-foreground">
                    {t('operator.payments.refunded', {
                      amount: formatMoney(money(payment.refundedCents)),
                    })}
                  </p>
                ) : null}
                {payment.surplus ? (
                  <Badge tone={unreviewed ? 'warning' : 'neutral'}>
                    {unreviewed
                      ? t('operator.payments.surplus')
                      : t('operator.payments.surplusReviewed')}
                  </Badge>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {refundable ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={WRAPPING_LABEL}
                      onClick={() => {
                        setRefunding({ payment, token: globalThis.crypto.randomUUID() });
                      }}
                    >
                      {t('operator.payments.refund')}
                    </Button>
                  ) : null}
                  {unreviewed ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={WRAPPING_LABEL}
                      onClick={() => {
                        setReviewing(payment);
                      }}
                    >
                      {t('operator.payments.review')}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('operator.payments.privacy')}</p>
      <RefundDialog
        tenantId={tenantId}
        request={refunding}
        onClose={() => {
          setRefunding(null);
        }}
      />
      <ReviewDialog
        tenantId={tenantId}
        payment={reviewing}
        onClose={() => {
          setReviewing(null);
        }}
      />
    </section>
  );
}
