import type { InvoiceDto } from '@consultorio/contracts';
import { money } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { formatCalendarDay, formatMoney } from '../../../shared/lib/format.js';
import { Button } from '../../../shared/ui/button.js';
import { voucherNumber } from '../domain/invoice-display.js';

import { EnvironmentBadge, InvoiceStateBadge } from './InvoiceBadges.js';
import { PendingNote } from './InvoiceDetailDialog.js';

/** One invoice in a list: what it is, for whom, how much, its state and what it says about it. */
export function InvoiceCard({
  invoice,
  thresholdHours,
  onOpen,
}: {
  invoice: InvoiceDto;
  thresholdHours: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation('invoicing');
  const number = voucherNumber(invoice.pointOfSale, invoice.number);
  const label = `${t(`voucher.${invoice.type}`)} ${number}`.trim();
  return (
    <li className="grid gap-2 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{label}</p>
          <p className="truncate text-sm text-muted-foreground">
            {invoice.recipient.name ?? t('recipient.finalConsumer')}
            {invoice.status === 'issued' || invoice.status === 'manual'
              ? ` · ${formatCalendarDay(invoice.issueDate)}`
              : ''}
          </p>
        </div>
        <InvoiceStateBadge invoice={invoice} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <EnvironmentBadge environment={invoice.environment} testDocument={invoice.testDocument} />
        <span className="tabular-nums font-semibold">{formatMoney(money(invoice.totalCents))}</span>
      </div>
      {invoice.status === 'pending' ? (
        <PendingNote invoice={invoice} thresholdHours={thresholdHours} />
      ) : null}
      {invoice.status === 'rejected' && invoice.rejectionMessage ? (
        <p className="text-sm text-danger-soft-foreground">
          {t('rejected.message', { message: invoice.rejectionMessage })}
        </p>
      ) : null}
      <div>
        <Button type="button" size="sm" variant="outline" onClick={onOpen}>
          {t('list.open', { voucher: label })}
        </Button>
      </div>
    </li>
  );
}
