import type { ChargeDto } from '@consultorio/contracts';
import { money } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { hasAnyPermission, useMe } from '../../../app/session.js';
import { DEFAULT_TIME_ZONE, formatMoney, formatTime } from '../../../shared/lib/format.js';
import { Button } from '../../../shared/ui/button.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { billingApi, billingKeys } from '../../billing/index.js';
import { canInvoiceCharge, issuableLines } from '../domain/invoice-display.js';

import { IssueInvoiceDialog } from './IssueInvoiceDialog.js';
import { ManualInvoiceDialog } from './ManualInvoiceDialog.js';

/** A day in the time zone of the organization, `days` days from today. */
function day(daysFromToday: number): string {
  const moment = new Date(Date.now() + daysFromToday * 86_400_000);
  return moment.toLocaleDateString('en-CA', { timeZone: DEFAULT_TIME_ZONE });
}

/**
 * The charges of a period that still have something to invoice, each with the action to do it: the
 * issue flow from a charge (e-invoicing-afip, "Issuing an invoice with CAE"). Charges are read from
 * billing, which decides who sees which; a voided charge, or one already invoiced in full, is left
 * out.
 */
/**
 * The name of the patient is part of the label of the button, and a long name must wrap inside the
 * button instead of making the whole page wider than a phone.
 */
const WRAP = 'h-auto max-w-full whitespace-normal py-2 text-left';

export function ChargesToInvoice({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation('invoicing');
  const api = useApi();
  const me = useMe();
  const canIssue = hasAnyPermission(me.permissions, ['invoicing.issue']) && !readOnly;
  const canManual = hasAnyPermission(me.permissions, ['invoicing.manual']) && !readOnly;
  const [from, setFrom] = useState(day(-6));
  const [to, setTo] = useState(day(0));
  const [issuing, setIssuing] = useState<ChargeDto | null>(null);
  const [registering, setRegistering] = useState<ChargeDto | null>(null);

  const valid = from !== '' && to !== '' && from <= to;
  const filters = { from, to };
  const list = useQuery({
    queryKey: billingKeys.charges(filters),
    queryFn: () => billingApi(api).charges(filters),
    enabled: valid,
  });
  const charges = (list.data?.charges ?? []).filter(canInvoiceCharge);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="to-invoice-from">{t('charges.from')}</Label>
          <Input
            id="to-invoice-from"
            type="date"
            value={from}
            className="w-44"
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to-invoice-to">{t('charges.to')}</Label>
          <Input
            id="to-invoice-to"
            type="date"
            value={to}
            className="w-44"
            onChange={(event) => {
              setTo(event.target.value);
            }}
          />
        </div>
      </div>
      {!valid ? (
        <p className="text-sm text-danger-soft-foreground">{t('charges.invalidPeriod')}</p>
      ) : null}

      {valid && list.isPending ? <ListSkeleton rows={3} /> : null}
      {list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : null}
      {list.isSuccess && charges.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={t('charges.empty.title')}
          description={t('charges.empty.description')}
        />
      ) : null}
      {charges.length > 0 ? (
        <ul aria-label={t('charges.caption')} className="grid gap-3">
          {charges.map((charge) => {
            const left = [
              ...issuableLines(charge, 'patient'),
              ...issuableLines(charge, 'payer'),
            ].reduce((sum, line) => sum + line.leftCents, 0);
            return (
              <li key={charge.id} className="grid gap-2 rounded-lg border bg-card p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{charge.patientName}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatTime(charge.startsAt)} · {charge.appointmentTypeName} ·{' '}
                    {charge.professionalName}
                  </p>
                </div>
                <p className="text-sm">
                  {t('charges.toInvoice')}:{' '}
                  <span className="tabular-nums font-semibold">{formatMoney(money(left))}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {canIssue ? (
                    <Button
                      type="button"
                      size="sm"
                      className={WRAP}
                      onClick={() => {
                        setIssuing(charge);
                      }}
                    >
                      {t('charges.issue', { patient: charge.patientName })}
                    </Button>
                  ) : null}
                  {canManual ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={WRAP}
                      onClick={() => {
                        setRegistering(charge);
                      }}
                    >
                      {t('charges.manual', { patient: charge.patientName })}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {issuing ? (
        <IssueInvoiceDialog
          source={{ kind: 'charge', charge: issuing }}
          onClose={() => {
            setIssuing(null);
          }}
        />
      ) : null}
      {registering ? (
        <ManualInvoiceDialog
          kind="patient"
          lines={issuableLines(registering, 'patient').map((line) => ({
            chargeLineId: line.id,
            description: line.description,
            amountCents: line.leftCents,
          }))}
          onClose={() => {
            setRegistering(null);
          }}
        />
      ) : null}
    </div>
  );
}
