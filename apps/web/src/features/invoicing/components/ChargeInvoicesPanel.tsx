import type { CalendarEntryDto } from '@consultorio/contracts';
import { money } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { hasAnyPermission, useMe } from '../../../app/session.js';
import { formatMoney } from '../../../shared/lib/format.js';
import { Button } from '../../../shared/ui/button.js';
import { Skeleton } from '../../../shared/ui/skeleton.js';
import { billingApi, billingKeys, ErrorAlert } from '../../billing/index.js';
import { invoicingApi, invoicingKeys } from '../api/invoicing-api.js';
import { canInvoiceCharge, issuableLines, voucherNumber } from '../domain/invoice-display.js';

import { InvoiceStateBadge } from './InvoiceBadges.js';
import { IssueInvoiceDialog } from './IssueInvoiceDialog.js';
import { ManualInvoiceDialog } from './ManualInvoiceDialog.js';

/**
 * In the appointment drawer, under the charge: the invoices that cover it and the actions to ask
 * for another one (e-invoicing-afip, "Issuing an invoice with CAE") or, for the owner and the
 * administration, to register one issued outside the system. Draws nothing until the appointment has
 * a charge: there is nothing to invoice before.
 */
export function ChargeInvoicesPanel({
  appointment,
  readOnly,
}: {
  appointment: CalendarEntryDto;
  readOnly: boolean;
}) {
  const { t } = useTranslation('invoicing');
  const api = useApi();
  const me = useMe();
  const canIssue = hasAnyPermission(me.permissions, ['invoicing.issue']) && !readOnly;
  const canManual = hasAnyPermission(me.permissions, ['invoicing.manual']) && !readOnly;
  const [dialog, setDialog] = useState<'issue' | 'manual' | null>(null);

  const charges = useQuery({
    queryKey: billingKeys.chargesOf(appointment.id),
    queryFn: () => billingApi(api).charges({ appointmentId: appointment.id }),
  });
  const charge = charges.data?.charges.find((entry) => entry.status !== 'voided');
  const invoices = useQuery({
    queryKey: invoicingKeys.invoices({ chargeId: charge?.id }),
    queryFn: () => invoicingApi(api).invoices({ chargeId: charge?.id }),
    enabled: charge !== undefined,
    refetchInterval: (query) =>
      query.state.data?.invoices.some((entry) => entry.status === 'pending') ? 5000 : false,
  });

  if (charges.isPending) return <Skeleton className="mt-4 h-10 w-full" />;
  if (!charge) return null;

  const invoiceable = canInvoiceCharge(charge);
  const list = invoices.data?.invoices ?? [];
  return (
    <section aria-labelledby="charge-invoices-title" className="mt-4 grid gap-3 border-t pt-4">
      <h3 id="charge-invoices-title" className="font-display text-base font-semibold">
        {t('panel.title')}
      </h3>
      {invoices.isError ? <ErrorAlert error={invoices.error} /> : null}
      {list.length === 0 && invoices.isSuccess ? (
        <p className="text-sm text-muted-foreground">{t('panel.none')}</p>
      ) : null}
      {list.length > 0 ? (
        <ul aria-label={t('panel.list')} className="grid gap-2">
          {list.map((invoice) => (
            <li
              key={invoice.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm"
            >
              <span>
                {t(`voucher.${invoice.type}`)} {voucherNumber(invoice.pointOfSale, invoice.number)}
              </span>
              <span className="flex items-center gap-2">
                <InvoiceStateBadge invoice={invoice} />
                <span className="tabular-nums">{formatMoney(money(invoice.totalCents))}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {invoiceable && (canIssue || canManual) ? (
        <div className="flex flex-wrap gap-2">
          {canIssue ? (
            <Button
              type="button"
              onClick={() => {
                setDialog('issue');
              }}
            >
              {t('panel.issue')}
            </Button>
          ) : null}
          {canManual ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDialog('manual');
              }}
            >
              {t('panel.manual')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {dialog === 'issue' ? (
        <IssueInvoiceDialog
          source={{ kind: 'charge', charge }}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === 'manual' ? (
        <ManualInvoiceDialog
          kind="patient"
          lines={issuableLines(charge, 'patient').map((line) => ({
            chargeLineId: line.id,
            description: line.description,
            amountCents: line.leftCents,
          }))}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
    </section>
  );
}
