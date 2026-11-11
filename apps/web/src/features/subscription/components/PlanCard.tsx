import {
  type Money,
  type PlanDto,
  type SubscriptionDto,
  type SubscriptionStatus,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate, formatMoney } from '../../../shared/lib/format.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogDestructiveAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription, AlertTitle } from '../../../shared/ui/alert.js';
import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { subscriptionApi, subscriptionKeys } from '../api/subscription-api.js';
import { goToProviderPage } from '../domain/provider-page.js';

import { ErrorNotice } from './ErrorNotice.js';

const TONES: Record<SubscriptionStatus, BadgeTone> = {
  trial: 'info',
  active: 'success',
  past_due: 'warning',
  read_only: 'danger',
  cancelling: 'warning',
  cancelled: 'neutral',
};

const money = (cents: number) => formatMoney(cents as Money);

/** The sentence that says what happens next and when, for the state the subscription is in. */
function nextText(
  t: (key: string, options?: Record<string, unknown>) => string,
  subscription: SubscriptionDto,
): string {
  const next = subscription.nextTransition;
  if (next === null) {
    return subscription.nextChargeAt === null
      ? t('subscription:next.none')
      : t('subscription:next.next_charge', { date: formatDate(subscription.nextChargeAt) });
  }
  return t(`subscription:next.${next.kind}`, { date: formatDate(next.at) });
}

/** Changes the plan, among the active ones. The new price applies from the next statement. */
function PlanChanger({ current }: { current: PlanDto }) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const queryClient = useQueryClient();
  const plans = useQuery({
    queryKey: subscriptionKeys.plans,
    queryFn: () => subscriptionApi(api).plans(),
  });
  const [choice, setChoice] = useState(current.key);
  const change = useMutation({
    mutationFn: () => subscriptionApi(api).changePlan(choice),
    onSuccess: async (view) => {
      toast.success(t('plans.changed'));
      queryClient.setQueryData(subscriptionKeys.view, view);
      await queryClient.invalidateQueries({ queryKey: subscriptionKeys.all });
    },
  });
  const options = plans.data ?? [];
  if (options.length < 2) return null;

  return (
    <form
      className="grid gap-2 sm:max-w-md"
      onSubmit={(event) => {
        event.preventDefault();
        if (choice !== current.key && !change.isPending) change.mutate();
      }}
    >
      <Label htmlFor="subscription-plan">{t('plans.label')}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select
          id="subscription-plan"
          value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
          }}
        >
          {options.map((plan) => (
            <option key={plan.key} value={plan.key}>
              {t('plans.option', { name: plan.name, price: money(plan.pricePerProfessionalCents) })}
            </option>
          ))}
        </Select>
        <Button
          type="submit"
          variant="outline"
          disabled={choice === current.key}
          loading={change.isPending}
        >
          {t('action.changePlan')}
        </Button>
      </div>
      <ErrorNotice error={change.error} />
    </form>
  );
}

/**
 * The plan and where the subscription stands: its state and the date of the next change, what is
 * charged and when, the medium of payment (the label the provider gives it, never a card number),
 * and what the owner can do from here. The words say the state; the color only repeats it.
 */
export function PlanCard({ subscription }: { subscription: SubscriptionDto }) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const queryClient = useQueryClient();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const { status, plan } = subscription;

  const refreshed = async (
    view: Awaited<ReturnType<ReturnType<typeof subscriptionApi>['cancel']>>,
  ) => {
    queryClient.setQueryData(subscriptionKeys.view, view);
    await queryClient.invalidateQueries({ queryKey: subscriptionKeys.all });
  };
  const authorize = useMutation({
    mutationFn: () => subscriptionApi(api).checkout(),
    onSuccess: (result) => {
      goToProviderPage(result.checkoutUrl);
    },
  });
  const payOverdue = useMutation({
    mutationFn: () => subscriptionApi(api).retryPayment(),
    onSuccess: (result) => {
      goToProviderPage(result.paymentUrl);
    },
  });
  const cancel = useMutation({
    mutationFn: () => subscriptionApi(api).cancel(),
    onSuccess: async (view) => {
      setConfirmCancel(false);
      toast.success(t('cancel.done'));
      await refreshed(view);
    },
    onError: () => {
      setConfirmCancel(false);
    },
  });
  const reactivate = useMutation({
    mutationFn: () => subscriptionApi(api).reactivate(),
    onSuccess: async (view) => {
      toast.success(t('reactivate.done'));
      await refreshed(view);
    },
  });

  const canAuthorize =
    subscription.authorization !== 'authorized' &&
    status !== 'cancelled' &&
    status !== 'cancelling';
  const canPay = status === 'past_due' || status === 'read_only';
  const canCancel = status !== 'cancelling' && status !== 'cancelled';
  const failure = authorize.error ?? payOverdue.error ?? cancel.error ?? reactivate.error;

  return (
    <Card aria-labelledby="plan-title" className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle id="plan-title">{t('plan.title')}</CardTitle>
          <Badge tone={TONES[status]}>{t(`status.${status}`)}</Badge>
        </div>
        <CardDescription>{nextText(t, subscription)}</CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        {subscription.needsAttention ? (
          <Alert tone="warning">
            <AlertTitle>{t('needsAttention.title')}</AlertTitle>
            <AlertDescription>{t('needsAttention.description')}</AlertDescription>
          </Alert>
        ) : null}

        <dl className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-muted-foreground">{plan.name}</dt>
            <dd className="break-words">
              {t('plan.price', { price: money(plan.pricePerProfessionalCents) })}
            </dd>
            <dd className="break-words text-muted-foreground">
              {t('plan.quota', { count: plan.whatsappQuotaPerProfessional })}
            </dd>
            <dd className="break-words text-muted-foreground">
              {t('plan.maxProfessionals', { count: plan.maxActiveProfessionals })}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">{t('plan.activeProfessionals')}</dt>
            <dd className="tabular">{subscription.activeProfessionals}</dd>
            <dt className="mt-3 text-muted-foreground">{t('plan.monthlyPrice')}</dt>
            <dd className="tabular">{money(subscription.monthlyPriceCents)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">{t('plan.paymentMethod')}</dt>
            <dd className="break-words">
              {subscription.paymentMethodLabel ?? t('plan.noPaymentMethod')}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">{t('plan.nextCharge')}</dt>
            <dd className="break-words">
              {subscription.nextChargeAt !== null && subscription.authorizedAmountCents !== null
                ? t('plan.nextChargeValue', {
                    amount: money(subscription.authorizedAmountCents),
                    date: formatDate(subscription.nextChargeAt),
                  })
                : t('plan.nextChargeUnknown')}
            </dd>
          </div>
          {status === 'trial' ? (
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t('plan.trialEnds')}</dt>
              <dd>{formatDate(subscription.trialEndsAt)}</dd>
            </div>
          ) : null}
          {subscription.graceEndsAt !== null &&
          (status === 'past_due' || status === 'read_only') ? (
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t('plan.graceEnds')}</dt>
              <dd>{formatDate(subscription.graceEndsAt)}</dd>
            </div>
          ) : null}
          {subscription.paidThrough !== null ? (
            <div className="min-w-0">
              <dt className="text-muted-foreground">{t('plan.paidThrough')}</dt>
              <dd>{formatDate(subscription.paidThrough)}</dd>
            </div>
          ) : null}
        </dl>

        <ErrorNotice error={failure} />

        <div className="flex flex-wrap gap-2">
          {canAuthorize ? (
            <Button
              type="button"
              loading={authorize.isPending}
              onClick={() => {
                authorize.mutate();
              }}
            >
              {t('action.authorize')}
            </Button>
          ) : null}
          {canPay ? (
            <Button
              type="button"
              variant={canAuthorize ? 'outline' : 'default'}
              loading={payOverdue.isPending}
              onClick={() => {
                payOverdue.mutate();
              }}
            >
              {t('action.payOverdue')}
            </Button>
          ) : null}
          {status === 'cancelling' ? (
            <Button
              type="button"
              loading={reactivate.isPending}
              onClick={() => {
                reactivate.mutate();
              }}
            >
              {t('action.reactivate')}
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setConfirmCancel(true);
              }}
            >
              {t('action.cancel')}
            </Button>
          ) : null}
        </div>

        {status !== 'cancelling' && status !== 'cancelled' ? <PlanChanger current={plan} /> : null}
      </CardContent>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cancel.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('cancel.description')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel.keep')}</AlertDialogCancel>
            <AlertDialogDestructiveAction
              onClick={() => {
                cancel.mutate();
              }}
            >
              {t('cancel.confirm')}
            </AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
