import type { CalendarEntryDto, Money, QuoteDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { hasAnyPermission, useMe } from '../../../app/session.js';
import { SimulatedBillingNotice } from '../../../app/SimulatedBillingNotice.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatMoney } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { MoneyInput } from '../../../shared/ui/money-input.js';
import { Skeleton } from '../../../shared/ui/skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingApi, billingKeys, type QuoteChoice } from '../api/billing-api.js';

import { ChargeBody } from './ChargeBody.js';
import { ErrorAlert } from './ErrorAlert.js';

/** Statuses from which a charge can be made for the service. */
const CHARGEABLE = new Set(['checked_in', 'in_progress', 'attended']);
/** Statuses that ended without the service: only a fee, if the organization enabled it. */
const ENDED = new Set(['no_show', 'cancelled']);

function QuoteLines({ quote }: { quote: QuoteDto }) {
  const { t } = useTranslation('billing');
  return (
    <div className="grid gap-2">
      <ul aria-label={t('quote.lines')} className="grid gap-1 rounded-md border bg-card">
        {quote.lines.map((line) => (
          <li
            key={line.kind}
            className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
          >
            <span>
              {t(`lineKind.${line.kind}`)}
              <span className="ml-2 text-xs text-muted-foreground">
                {t(`portion.${line.portion}`)}
              </span>
            </span>
            <span className="tabular-nums">{formatMoney(line.amountCents)}</span>
          </li>
        ))}
      </ul>
      <p className="flex items-baseline justify-between text-sm font-semibold">
        <span>{t('quote.patientPays')}</span>
        <span className="tabular-nums">{formatMoney(quote.patientCents)}</span>
      </p>
      {quote.reasons.map((reason) => (
        <Alert key={reason} tone="info">
          <AlertDescription>{t(`quote.reason.${reason}`)}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

/**
 * In the appointment drawer: the charge of the appointment. From check-in on it shows the price the
 * system would charge (the quote), lets the person choose the payer, and captures the charge; when
 * nothing prices the service it asks for the amount to be typed. Once a charge exists it shows it
 * whole. Before check-in it only says that the charge starts then.
 */
export function ChargePanel({
  appointment,
  readOnly,
}: {
  appointment: CalendarEntryDto;
  readOnly: boolean;
}) {
  const { t } = useTranslation(['billing', 'common']);
  const api = useApi();
  const me = useMe();
  const queryClient = useQueryClient();
  const canWrite = hasAnyPermission(me.permissions, ['payments.write']) && !readOnly;
  const [choice, setChoice] = useState<QuoteChoice>({});
  const [amount, setAmount] = useState<Money | null>(null);

  const existing = useQuery({
    queryKey: billingKeys.chargesOf(appointment.id),
    queryFn: () => billingApi(api).charges({ appointmentId: appointment.id }),
  });
  const charge = existing.data?.charges.find((entry) => entry.status !== 'voided');
  const voided = existing.data?.charges.filter((entry) => entry.status === 'voided') ?? [];
  const chargeable = CHARGEABLE.has(appointment.status);

  const quote = useQuery({
    queryKey: billingKeys.quote(appointment.id, choice),
    queryFn: () => billingApi(api).quote(appointment.id, choice),
    enabled: existing.isSuccess && charge === undefined && chargeable && canWrite,
  });
  const payers = useQuery({
    queryKey: billingKeys.payers,
    queryFn: () => billingApi(api).payers(),
    enabled: existing.isSuccess && charge === undefined && chargeable && canWrite,
  });

  const capture = useMutation({
    mutationFn: (explicit: Money | null) =>
      billingApi(api).capture({
        appointmentId: appointment.id,
        ...(choice.payer ? { payer: choice.payer } : {}),
        ...(choice.planName ? { planName: choice.planName } : {}),
        ...(explicit === null ? {} : { explicitAmountCents: explicit }),
      }),
    onSuccess: async () => {
      toast.success(t('billing:capture.done'));
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },
    onError: async (error) => {
      // A charge appeared meanwhile (another desk): show it instead of an error.
      if (isApiError(error) && error.code === 'conflict') {
        await queryClient.invalidateQueries({ queryKey: billingKeys.all });
      }
    },
  });

  const heading = (
    <h3 className="font-display text-base font-semibold">{t('billing:panel.title')}</h3>
  );

  if (existing.isPending) {
    return (
      <section aria-label={t('billing:panel.title')} className="mt-4 grid gap-3 border-t pt-4">
        {heading}
        <Skeleton className="h-16 w-full" />
      </section>
    );
  }
  if (existing.isError) {
    return (
      <section className="mt-4 grid gap-3 border-t pt-4">
        {heading}
        <ErrorAlert error={existing.error} />
      </section>
    );
  }

  const ended = ENDED.has(appointment.status);
  if (!charge && voided.length === 0 && !chargeable && !ended) {
    return (
      <section aria-labelledby="charge-panel-title" className="mt-4 grid gap-2 border-t pt-4">
        <h3 id="charge-panel-title" className="font-display text-base font-semibold">
          {t('billing:panel.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('billing:panel.beforeCheckIn')}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="charge-panel-title" className="mt-4 grid gap-3 border-t pt-4">
      <h3 id="charge-panel-title" className="font-display text-base font-semibold">
        {t('billing:panel.title')}
      </h3>
      <SimulatedBillingNotice />

      {charge ? <ChargeBody charge={charge} readOnly={readOnly} /> : null}

      {!charge && voided.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('billing:panel.voidedBefore', { count: voided.length })}
        </p>
      ) : null}

      {!charge && canWrite && chargeable ? (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="charge-payer">{t('billing:capture.payer')}</Label>
            <Select
              id="charge-payer"
              value={choice.payer ?? ''}
              onChange={(event) => {
                setChoice(event.target.value === '' ? {} : { payer: event.target.value });
              }}
            >
              <option value="">{t('billing:capture.byCoverage')}</option>
              <option value="private">{t('billing:capture.private')}</option>
              {(payers.data?.payers ?? [])
                .filter((payer) => payer.active)
                .map((payer) => (
                  <option key={payer.id} value={payer.id}>
                    {payer.name}
                  </option>
                ))}
            </Select>
          </div>

          {quote.isPending ? <Skeleton className="h-16 w-full" /> : null}
          {quote.isError ? <ErrorAlert error={quote.error} /> : null}

          {quote.data?.quote ? (
            <>
              <QuoteLines quote={quote.data.quote} />
              <Button
                type="button"
                loading={capture.isPending}
                onClick={() => {
                  if (!capture.isPending) capture.mutate(null);
                }}
              >
                {t('billing:capture.submit')}
              </Button>
            </>
          ) : null}

          {quote.data && quote.data.quote === null ? (
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!capture.isPending && amount !== null && amount > 0) capture.mutate(amount);
              }}
            >
              <Alert tone="warning">
                <AlertDescription>{t('billing:capture.noPrice')}</AlertDescription>
              </Alert>
              <div className="grid gap-1.5">
                <Label htmlFor="charge-explicit">{t('billing:capture.explicitAmount')}</Label>
                <MoneyInput id="charge-explicit" value={amount} onValueChange={setAmount} />
                <p className="text-sm text-muted-foreground">{t('billing:capture.explicitHint')}</p>
              </div>
              <Button
                type="submit"
                loading={capture.isPending}
                disabled={amount === null || amount <= 0}
              >
                {t('billing:capture.submitExplicit')}
              </Button>
            </form>
          ) : null}
          <ErrorAlert error={capture.error} />
        </div>
      ) : null}

      {!charge && canWrite && ended ? (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">{t('billing:capture.ended')}</p>
          <Button
            type="button"
            variant="outline"
            loading={capture.isPending}
            onClick={() => {
              if (!capture.isPending) capture.mutate(null);
            }}
          >
            {t('billing:capture.fee')}
          </Button>
          <ErrorAlert error={capture.error} />
        </div>
      ) : null}
    </section>
  );
}
