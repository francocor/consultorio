import {
  type Money,
  type SubscriptionUsageResponse,
  type UsageState,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatMoney, formatMonthYear } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { subscriptionApi, subscriptionKeys } from '../api/subscription-api.js';

import { ErrorNotice } from './ErrorNotice.js';

const TONES: Record<UsageState, BadgeTone> = {
  ok: 'success',
  warning: 'warning',
  exhausted: 'danger',
  unlimited: 'neutral',
};

const money = (cents: number) => formatMoney(cents as Money);

/**
 * The cap of overage messages: a whole number between 0 (overage off) and the maximum of the plan.
 * There is no way to leave it unlimited, here or in the API.
 */
function OverageCapForm({ usage }: { usage: SubscriptionUsageResponse }) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const queryClient = useQueryClient();
  const { capMessages, capMax, unitPriceCents } = usage.overage;
  const [text, setText] = useState(String(capMessages));
  const [invalid, setInvalid] = useState(false);
  const save = useMutation({
    mutationFn: (value: number) => subscriptionApi(api).setOverageCap(value),
    onSuccess: async () => {
      toast.success(t('cap.saved'));
      await queryClient.invalidateQueries({ queryKey: subscriptionKeys.all });
    },
  });

  return (
    <form
      noValidate
      className="grid gap-2 sm:max-w-md"
      aria-labelledby="cap-title"
      onSubmit={(event) => {
        event.preventDefault();
        const value = Number(text);
        if (text.trim() === '' || !Number.isInteger(value) || value < 0 || value > capMax) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        if (!save.isPending) save.mutate(value);
      }}
    >
      <h3 id="cap-title" className="font-medium">
        {t('cap.title')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('cap.description')}</p>
      <Label htmlFor="overage-cap">{t('cap.label')}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="overage-cap"
          type="number"
          inputMode="numeric"
          min={0}
          max={capMax}
          step={1}
          value={text}
          aria-describedby="overage-cap-help"
          aria-invalid={invalid}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
          }}
        />
        <Button type="submit" variant="outline" loading={save.isPending}>
          {t('cap.save')}
        </Button>
      </div>
      <p id="overage-cap-help" className="text-sm text-muted-foreground">
        {t('cap.help', { max: capMax, price: money(unitPriceCents) })}
      </p>
      {invalid ? (
        <p role="alert" className="text-sm text-destructive">
          {t('cap.invalid', { max: capMax })}
        </p>
      ) : null}
      <ErrorNotice error={save.error} />
    </form>
  );
}

/**
 * The WhatsApp usage of the month, per professional and in total: how many were sent, the quota,
 * what remains and what the overage would cost. Counts only: nothing here names a patient or shows a
 * message. The statement of the month bills what the overage line says.
 */
export function UsageCard() {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const usage = useQuery({
    queryKey: subscriptionKeys.usage,
    queryFn: () => subscriptionApi(api).usage(),
  });

  return (
    <Card aria-labelledby="usage-title" className="min-w-0">
      <CardHeader>
        <CardTitle id="usage-title">{t('usage.title')}</CardTitle>
        <CardDescription>{t('usage.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        {usage.isPending ? <ListSkeleton rows={2} /> : null}
        {usage.isError ? (
          <ErrorState
            error={usage.error}
            onRetry={() => {
              void usage.refetch();
            }}
          />
        ) : null}
        {usage.isSuccess ? <UsageBody usage={usage.data} /> : null}
      </CardContent>
    </Card>
  );
}

function UsageBody({ usage }: { usage: SubscriptionUsageResponse }) {
  const { t } = useTranslation('subscription');
  const { overage, totals } = usage;
  return (
    <>
      <p className="text-sm font-medium">
        {t('usage.period', { period: formatMonthYear(`${usage.period}-01`) })}
      </p>

      {usage.professionals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('usage.none')}</p>
      ) : (
        <ul className="grid min-w-0 gap-2">
          {usage.professionals.map((entry) => (
            <li
              key={entry.professionalId}
              className="grid min-w-0 gap-1 rounded-md border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center sm:gap-x-4"
            >
              <div className="min-w-0">
                <p className="break-words font-medium">{entry.name ?? t('usage.unnamed')}</p>
                <p className="text-muted-foreground">
                  {t('usage.professional', { count: entry.count, quota: entry.quota })}
                  {' · '}
                  {t('usage.remaining', { count: entry.remaining })}
                  {entry.overageUnits > 0
                    ? ` · ${t('usage.overage', { count: entry.overageUnits })}`
                    : ''}
                </p>
              </div>
              <Badge tone={TONES[entry.state]}>{t(`usage.state.${entry.state}`)}</Badge>
            </li>
          ))}
        </ul>
      )}

      <p className="text-sm">
        {t('usage.totals', {
          count: totals.count,
          quota: totals.quota,
          remaining: totals.remaining,
        })}
      </p>
      <p className="text-sm text-muted-foreground">
        {overage.billableUnits > 0
          ? t('usage.projected', {
              units: overage.billableUnits,
              amount: money(overage.projectedCents),
            })
          : t('usage.noOverage')}
      </p>
      {overage.capReached ? (
        <Alert tone="info">
          <AlertDescription>{t('usage.capReached')}</AlertDescription>
        </Alert>
      ) : null}

      <OverageCapForm key={overage.capMessages} usage={usage} />
    </>
  );
}
