import type { InvoiceDto } from '@consultorio/contracts';
import { money } from '@consultorio/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { hasAnyPermission, useMe } from '../../../app/session.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { formatCalendarDay, formatDateTime, formatMoney } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { ErrorAlert } from '../../billing/index.js';
import { invoicingApi, invoicingKeys } from '../api/invoicing-api.js';
import { ageParts, creditableCents, voucherNumber } from '../domain/invoice-display.js';

import { CreditNoteDialog } from './CreditNoteDialog.js';
import { EnvironmentBadge, InvoiceStateBadge } from './InvoiceBadges.js';
import { IssueInvoiceDialog } from './IssueInvoiceDialog.js';
import { ManualInvoiceDialog } from './ManualInvoiceDialog.js';

/** "hace 25 horas", from the biggest unit that reads well. */
export function AgeText({ minutes }: { minutes: number }) {
  const { t } = useTranslation('invoicing');
  const { unit, count } = ageParts(minutes);
  return <>{t(`age.${unit}`, { count })}</>;
}

/**
 * What a pending invoice says about itself, in words: it is not issued yet, how long ago it was
 * asked for, and that it will be issued when the service recovers. Never the retry progress. Past
 * the threshold it says what the owner can do.
 */
export function PendingNote({
  invoice,
  thresholdHours,
  onOpenInvoice,
}: {
  invoice: Pick<InvoiceDto, 'ageMinutes' | 'outageFlag' | 'heldBy' | 'blocksSeries'>;
  thresholdHours: number;
  /** Opens another invoice of the list (the one that holds this one back). */
  onOpenInvoice?: ((id: string) => void) | undefined;
}) {
  const { t } = useTranslation('invoicing');
  return (
    <div className="grid gap-1 text-sm">
      <p className="text-muted-foreground">
        {t('pending.message')}
        {invoice.ageMinutes === null ? null : (
          <>
            {' '}
            {t('pending.asked')} <AgeText minutes={invoice.ageMinutes} />.
          </>
        )}
      </p>
      {invoice.heldBy ? (
        <p className="text-muted-foreground">
          {t('pending.heldBy', { when: formatDateTime(invoice.heldBy.requestedAt) })}
          {onOpenInvoice ? (
            <>
              {' '}
              <Button
                type="button"
                variant="link"
                className="inline h-auto align-baseline"
                onClick={() => {
                  if (invoice.heldBy) onOpenInvoice(invoice.heldBy.id);
                }}
              >
                {t('pending.heldByLink')}
              </Button>
            </>
          ) : null}
        </p>
      ) : null}
      {invoice.blocksSeries > 0 ? (
        <p className="font-medium">{t('pending.blocks', { count: invoice.blocksSeries })}</p>
      ) : null}
      {invoice.outageFlag ? (
        <p className="font-medium text-danger-soft-foreground">
          {t('outage.hint', { hours: thresholdHours })}
        </p>
      ) : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

type Open = 'credit' | 'manual' | 'retry' | null;

/**
 * One invoice in full: its state, recipient, lines and fiscal data, the credit notes it has, and
 * what can be done with it. A pending invoice is registered by hand by the owner or an admin; a
 * rejected attempt is retried; an issued one is downloaded and, by the owner or an admin, credited.
 * An issued invoice is never edited or voided: the only way back is a credit note.
 */
export function InvoiceDetailDialog({
  invoice,
  readOnly,
  thresholdHours,
  onClose,
  onOpenInvoice,
}: {
  invoice: InvoiceDto;
  readOnly: boolean;
  thresholdHours: number;
  onClose: () => void;
  onOpenInvoice?: ((id: string) => void) | undefined;
}) {
  const { t } = useTranslation(['invoicing', 'common']);
  const api = useApi();
  const me = useMe();
  const [open, setOpen] = useState<Open>(null);
  const canIssue = hasAnyPermission(me.permissions, ['invoicing.issue']) && !readOnly;
  const canNote = hasAnyPermission(me.permissions, ['invoicing.credit_note']) && !readOnly;
  const canManual = hasAnyPermission(me.permissions, ['invoicing.manual']) && !readOnly;
  const isInvoice = invoice.kind === 'invoice';
  const standing = invoice.status === 'issued' || invoice.status === 'manual';

  const notes = useQuery({
    queryKey: invoicingKeys.invoices({ creditNoteOfId: invoice.id }),
    queryFn: () => invoicingApi(api).invoices({ creditNoteOfId: invoice.id }),
    enabled: isInvoice && standing,
  });
  const download = useMutation({
    mutationFn: () => invoicingApi(api).downloadPdf(invoice.id),
    onSuccess: (file) => {
      downloadBlob(
        file.blob,
        file.filename ??
          `${invoice.type}-${voucherNumber(invoice.pointOfSale, invoice.number)}.pdf`,
      );
    },
  });

  const number = voucherNumber(invoice.pointOfSale, invoice.number);
  const left = creditableCents(invoice);
  const manualLines = invoice.lines.map((line) => ({
    chargeLineId: line.chargeLineId,
    description: line.description,
    amountCents: line.amountCents,
  }));

  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(`invoicing:voucher.${invoice.type}`)} {number}
            </DialogTitle>
            <DialogDescription>
              {invoice.recipient.name ?? t('invoicing:recipient.finalConsumer')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <InvoiceStateBadge invoice={invoice} />
            <EnvironmentBadge
              environment={invoice.environment}
              testDocument={invoice.testDocument}
            />
          </div>

          {invoice.status === 'pending' ? (
            <PendingNote
              invoice={invoice}
              thresholdHours={thresholdHours}
              onOpenInvoice={onOpenInvoice}
            />
          ) : null}
          {invoice.status === 'rejected' && invoice.rejectionMessage ? (
            <Alert tone="danger">
              <AlertDescription>
                {t('invoicing:rejected.message', { message: invoice.rejectionMessage })}
              </AlertDescription>
            </Alert>
          ) : null}

          <dl className="grid gap-1.5">
            <Detail label={t('invoicing:detail.issueDate')}>
              {formatCalendarDay(invoice.issueDate)}
            </Detail>
            {invoice.cae ? <Detail label={t('invoicing:detail.cae')}>{invoice.cae}</Detail> : null}
            {invoice.caeExpiresOn ? (
              <Detail label={t('invoicing:detail.caeExpires')}>
                {formatCalendarDay(invoice.caeExpiresOn)}
              </Detail>
            ) : null}
            <Detail label={t('invoicing:detail.recipient')}>
              {t(`invoicing:recipient.conditions.${invoice.recipient.taxCondition}`)}
              {invoice.recipient.document
                ? ` · ${t(`invoicing:recipient.${invoice.recipient.document.type}`)} ${invoice.recipient.document.number}`
                : ''}
            </Detail>
            <Detail label={t('invoicing:detail.requested')}>
              {formatDateTime(invoice.createdAt)}
            </Detail>
            {invoice.creditNoteOfId ? (
              <Detail label={t('invoicing:detail.reason')}>{invoice.reason ?? ''}</Detail>
            ) : null}
          </dl>

          <ul
            aria-label={t('invoicing:detail.lines')}
            className="grid gap-1 rounded-md border bg-card"
          >
            {invoice.lines.map((line) => (
              <li
                key={line.id}
                className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
              >
                <span>{line.description}</span>
                <span className="tabular-nums">{formatMoney(money(line.amountCents))}</span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm font-semibold">
              <span>{t('invoicing:detail.total')}</span>
              <span className="tabular-nums">{formatMoney(money(invoice.totalCents))}</span>
            </li>
          </ul>

          {isInvoice && standing && (notes.data?.invoices.length ?? 0) > 0 ? (
            <section aria-label={t('invoicing:detail.notes')} className="grid gap-1">
              <h3 className="text-sm font-medium">{t('invoicing:detail.notes')}</h3>
              <ul className="grid gap-1">
                {notes.data?.invoices.map((note) => (
                  <li
                    key={note.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <span>
                      {t(`invoicing:voucher.${note.type}`)}{' '}
                      {voucherNumber(note.pointOfSale, note.number)}
                    </span>
                    <span className="flex items-center gap-2">
                      <InvoiceStateBadge invoice={note} />
                      <span className="tabular-nums">{formatMoney(money(note.totalCents))}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <ErrorAlert error={download.error} />
          <div className="flex flex-wrap gap-2">
            {invoice.status === 'issued' && invoice.hasPdf ? (
              <Button
                type="button"
                variant="outline"
                loading={download.isPending}
                onClick={() => {
                  if (!download.isPending) download.mutate();
                }}
              >
                {t('invoicing:actions.pdf')}
              </Button>
            ) : null}
            {invoice.status === 'issued' && !invoice.hasPdf ? (
              <p className="text-sm text-muted-foreground">{t('invoicing:detail.pdfPending')}</p>
            ) : null}
            {isInvoice && standing && canNote && left > 0 ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen('credit');
                }}
              >
                {t('invoicing:actions.creditNote')}
              </Button>
            ) : null}
            {invoice.status === 'pending' && canManual ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen('manual');
                }}
              >
                {t('invoicing:actions.manual')}
              </Button>
            ) : null}
            {invoice.status === 'rejected' && canIssue && isInvoice ? (
              <Button
                type="button"
                onClick={() => {
                  setOpen('retry');
                }}
              >
                {t('invoicing:actions.retry')}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {open === 'credit' ? (
        <CreditNoteDialog
          invoice={invoice}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {open === 'manual' ? (
        <ManualInvoiceDialog
          lines={manualLines}
          kind={invoice.recipient.kind}
          replacesInvoiceId={invoice.id}
          defaultType={invoice.type}
          recipient={{
            taxCondition: invoice.recipient.taxCondition,
            name: invoice.recipient.name ?? '',
            docType: invoice.recipient.document?.type ?? 'dni',
            docNumber: invoice.recipient.document?.number ?? '',
          }}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {open === 'retry' ? (
        <IssueInvoiceDialog
          source={{ kind: 'retry', invoice }}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
    </>
  );
}
