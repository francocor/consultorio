import type { ChargeDto, Money, PaymentDto } from '@consultorio/contracts';
import { Flag, Plus, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { hasAnyPermission, useMe } from '../../../app/session.js';
import { formatDateTime, formatMoney } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';

import { AddLineDialog } from './AddLineDialog.js';
import { ChargeStatusBadge } from './ChargeStatusBadge.js';
import { CorrectPaymentDialog } from './CorrectPaymentDialog.js';
import { PaymentDialog } from './PaymentDialog.js';
import { RefundDialog } from './RefundDialog.js';
import { VoidChargeDialog } from './VoidChargeDialog.js';

type Open =
  | { kind: 'pay' }
  | { kind: 'line' }
  | { kind: 'void' }
  | { kind: 'refund'; payment: PaymentDto }
  | { kind: 'correct'; payment: PaymentDto };

/** One line of the totals: a label and an amount, tabular so the columns line up. */
function Total({
  label,
  amount,
  strong = false,
}: {
  label: string;
  amount: Money;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-base font-semibold' : ''}`}>
        {formatMoney(amount)}
      </dd>
    </div>
  );
}

/**
 * A charge as the desk reads it: its state, the lines, who owes what, the payments with their
 * refunds, and the actions the person may take (record a payment, add a line, refund, correct,
 * void). The server decides every one of them again; hiding an action is a courtesy.
 */
export function ChargeBody({ charge, readOnly }: { charge: ChargeDto; readOnly: boolean }) {
  const { t } = useTranslation(['billing', 'common']);
  const me = useMe();
  const [open, setOpen] = useState<Open | null>(null);
  const canWrite = hasAnyPermission(me.permissions, ['payments.write']) && !readOnly;
  const canRefund = hasAnyPermission(me.permissions, ['payments.refund']) && !readOnly;
  const canVoid = hasAnyPermission(me.permissions, ['charges.void']) && !readOnly;
  const live = charge.status !== 'voided';
  const close = () => {
    setOpen(null);
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <ChargeStatusBadge status={charge.status} />
        {charge.explicitAmount ? (
          <span className="text-sm text-muted-foreground">{t('billing:charge.explicit')}</span>
        ) : null}
        {charge.payerName ? (
          <span className="text-sm text-muted-foreground">
            {charge.planName
              ? t('billing:charge.payerPlan', { payer: charge.payerName, plan: charge.planName })
              : charge.payerName}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">{t('billing:charge.private')}</span>
        )}
      </div>

      {charge.needsReview && live ? (
        <Alert tone="warning">
          <AlertDescription>
            <span className="inline-flex items-center gap-2 font-medium">
              <Flag aria-hidden="true" className="size-4" />
              {t(`billing:review.${charge.reviewReason ?? 'cancelled'}`)}
            </span>
            <span>{t('billing:review.hint')}</span>
          </AlertDescription>
        </Alert>
      ) : null}

      {charge.status === 'voided' ? (
        <Alert tone="info">
          <AlertDescription>
            {t('billing:void.reasonShown', { reason: charge.voidReason ?? '' })}
          </AlertDescription>
        </Alert>
      ) : null}

      <ul aria-label={t('billing:charge.lines')} className="grid gap-1 rounded-md border bg-card">
        {charge.lines.map((line) => (
          <li
            key={line.id}
            className="flex items-baseline justify-between gap-3 border-b px-3 py-2 last:border-b-0"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm">
                {line.kind === 'service' || line.kind === 'manual'
                  ? line.description
                  : t(`billing:lineKind.${line.kind}`, { defaultValue: line.description })}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(`billing:portion.${line.portion}`)}
              </span>
            </span>
            <span className="tabular-nums text-sm">{formatMoney(line.amountCents)}</span>
          </li>
        ))}
      </ul>

      <dl className="grid gap-1 text-sm">
        <Total label={t('billing:totals.total')} amount={charge.totalCents} />
        <Total label={t('billing:totals.patient')} amount={charge.patientCents} />
        {charge.payerCents > 0 ? (
          <Total label={t('billing:totals.payer')} amount={charge.payerCents} />
        ) : null}
        <Total label={t('billing:totals.paid')} amount={charge.paidCents} />
        <Total label={t('billing:totals.outstanding')} amount={charge.outstandingCents} strong />
        {charge.creditCents > 0 ? (
          <Total label={t('billing:totals.credit')} amount={charge.creditCents} />
        ) : null}
      </dl>
      {charge.payerCents > 0 ? (
        <p className="text-sm text-muted-foreground">{t('billing:totals.payerNote')}</p>
      ) : null}

      {charge.payments.length > 0 ? (
        <section aria-labelledby={`payments-${charge.id}`} className="grid gap-2">
          <h4 id={`payments-${charge.id}`} className="text-sm font-semibold">
            {t('billing:payments.title')}
          </h4>
          <ul className="grid gap-2">
            {charge.payments.map((payment) => (
              <li key={payment.id} className="grid gap-1 rounded-md border bg-card p-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span>
                    {t(`billing:method.${payment.method}`)}
                    {payment.externalRef ? ` · ${payment.externalRef}` : ''}
                  </span>
                  <span className="tabular-nums font-medium">
                    {formatMoney(payment.amountCents)}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDateTime(payment.paidAt)}
                </div>
                {payment.correctsPaymentId ? (
                  <div className="text-xs text-muted-foreground">
                    {t('billing:payments.corrects')}
                  </div>
                ) : null}
                {payment.creditCents > 0 ? (
                  <div className="text-xs">
                    {t('billing:payments.credit', { amount: formatMoney(payment.creditCents) })}
                  </div>
                ) : null}
                {payment.reversals.map((reversal) => (
                  <div key={reversal.id} className="text-xs text-muted-foreground">
                    {t(`billing:reversal.${reversal.kind}`, {
                      amount: formatMoney(reversal.amountCents),
                      reason: reversal.reason,
                    })}
                  </div>
                ))}
                {canRefund && payment.netCents > 0 && live ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOpen({ kind: 'refund', payment });
                      }}
                    >
                      <Undo2 aria-hidden="true" />
                      {t('billing:payments.refund')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setOpen({ kind: 'correct', payment });
                      }}
                    >
                      {t('billing:payments.correct')}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {live ? (
        <div className="flex flex-wrap gap-2">
          {canWrite ? (
            <Button
              type="button"
              onClick={() => {
                setOpen({ kind: 'pay' });
              }}
            >
              {t('billing:actions.pay')}
            </Button>
          ) : null}
          {canWrite ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen({ kind: 'line' });
              }}
            >
              <Plus aria-hidden="true" />
              {t('billing:actions.addLine')}
            </Button>
          ) : null}
          {canVoid ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen({ kind: 'void' });
              }}
            >
              {t('billing:actions.void')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {live && !readOnly && (!canVoid || (!canRefund && charge.payments.length > 0)) ? (
        <p className="text-xs text-muted-foreground">
          {t(canVoid ? 'billing:actions.refundRestricted' : 'billing:actions.voidRestricted')}
        </p>
      ) : null}

      {open?.kind === 'pay' ? <PaymentDialog charge={charge} onClose={close} /> : null}
      {open?.kind === 'line' ? <AddLineDialog charge={charge} onClose={close} /> : null}
      {open?.kind === 'void' ? <VoidChargeDialog charge={charge} onClose={close} /> : null}
      {open?.kind === 'refund' ? <RefundDialog payment={open.payment} onClose={close} /> : null}
      {open?.kind === 'correct' ? (
        <CorrectPaymentDialog payment={open.payment} onClose={close} />
      ) : null}
    </div>
  );
}
