import {
  type OperatorSubscriptionDto,
  type OperatorTenantDto,
  type SubscriptionStatus,
} from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate, formatMonthYear } from '../../../shared/lib/format.js';
import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';
import { Button, WRAPPING_LABEL } from '../../../shared/ui/button.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { operatorApi, operatorKeys } from '../api/operator-api.js';

import { operatorSubscriptionKeys, operatorSubscriptionsApi } from './subscriptions-api.js';

const TONES: Record<SubscriptionStatus, BadgeTone> = {
  trial: 'info',
  active: 'success',
  past_due: 'warning',
  read_only: 'danger',
  cancelling: 'warning',
  cancelled: 'neutral',
};

/** The counts of one organization: days of activity and messages per professional and month. */
function UsagePanel({ tenantId, name }: { tenantId: string; name: string }) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const usage = useQuery({
    queryKey: operatorSubscriptionKeys.usage(tenantId),
    queryFn: () => operatorSubscriptionsApi(api).usage(tenantId),
  });

  return (
    <section aria-label={t('operator.usage.title', { name })} className="grid gap-2 border-t pt-3">
      <h3 className="text-sm font-medium">{t('operator.usage.title', { name })}</h3>
      {usage.isPending ? <ListSkeleton rows={2} /> : null}
      {usage.isError ? (
        <ErrorState
          error={usage.error}
          onRetry={() => {
            void usage.refetch();
          }}
        />
      ) : null}
      {usage.isSuccess && usage.data.periods.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('operator.usage.none')}</p>
      ) : null}
      {usage.isSuccess
        ? usage.data.periods.map((period) => (
            <div key={period.period} className="grid gap-1 text-sm">
              <p className="font-medium">
                {t('operator.usage.period', { period: formatMonthYear(`${period.period}-01`) })}
              </p>
              <ul className="grid gap-0.5 text-muted-foreground">
                {period.professionals.map((entry) => (
                  <li key={entry.professionalId} className="break-words">
                    {t('operator.usage.row', {
                      id: entry.professionalId.slice(0, 8),
                      days: entry.activeDays,
                      messages: entry.messages,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ))
        : null}
      <p className="text-xs text-muted-foreground">{t('operator.usage.privacy')}</p>
    </section>
  );
}

function SubscriptionRow({
  subscription,
  tenant,
}: {
  subscription: OperatorSubscriptionDto;
  tenant: OperatorTenantDto | undefined;
}) {
  const { t } = useTranslation('subscription');
  const [showUsage, setShowUsage] = useState(false);
  const name = tenant?.name ?? subscription.id.slice(0, 8);
  const flags: string[] = [];
  if (subscription.attentionReason !== null) {
    const reason = t(`operator.attention.${subscription.attentionReason}`, {
      defaultValue: subscription.attentionReason,
    });
    flags.push(t('operator.flag.attention', { reason }));
  }
  if (subscription.surplusFlags > 0) {
    flags.push(t('operator.flag.surplus', { count: subscription.surplusFlags }));
  }
  const dates: string[] = [];
  if (subscription.status === 'trial') {
    dates.push(t('operator.dates.trial', { date: formatDate(subscription.trialEndsAt) }));
  }
  if (subscription.graceEndsAt !== null) {
    dates.push(t('operator.dates.grace', { date: formatDate(subscription.graceEndsAt) }));
  }
  if (subscription.paidThrough !== null) {
    dates.push(t('operator.dates.paidThrough', { date: formatDate(subscription.paidThrough) }));
  }

  return (
    <li className="grid min-w-0 gap-2 rounded-lg border bg-card p-4 text-sm">
      <article aria-label={name} className="grid min-w-0 gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="break-words font-medium">{name}</h2>
          <Badge tone={TONES[subscription.status]}>{t(`status.${subscription.status}`)}</Badge>
        </div>
        <p className="text-muted-foreground">
          {subscription.planKey}
          {' · '}
          {t(`operator.authorization.${subscription.authorization}`)}
          {' · '}
          {t('operator.cap', { count: subscription.overageCapMessages })}
        </p>
        {dates.length > 0 ? <p className="text-muted-foreground">{dates.join(' · ')}</p> : null}
        {flags.length > 0 ? (
          <ul className="grid gap-1">
            {flags.map((flag) => (
              <li key={flag}>
                <Badge tone="warning">{flag}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{t('operator.flag.none')}</p>
        )}
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={WRAPPING_LABEL}
            aria-expanded={showUsage}
            aria-label={t('operator.usage.showLabel', { name })}
            onClick={() => {
              setShowUsage((current) => !current);
            }}
          >
            {t('operator.usage.show')}
          </Button>
        </div>
        {showUsage ? <UsagePanel tenantId={subscription.id} name={name} /> : null}
      </article>
    </li>
  );
}

/**
 * The subscriptions tab of the operator console (SUB-17): the state, the dates and the counters of
 * each organization, the parked ones and the duplicate payments waiting for a look, and the usage
 * counts of one organization. It shows billing and counts only: the operator's database role has no
 * privilege on any patient or clinical table, so there is nothing else to show.
 */
export function SubscriptionsTab() {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const subscriptions = useQuery({
    queryKey: operatorSubscriptionKeys.list,
    queryFn: () => operatorSubscriptionsApi(api).list(),
  });
  // The names of the organizations come from the list the console already has.
  const tenants = useQuery({
    queryKey: operatorKeys.tenants,
    queryFn: () => operatorApi(api).tenants(),
  });
  const names = new Map((tenants.data ?? []).map((tenant) => [tenant.id, tenant]));

  return (
    <div className="grid min-w-0 gap-4">
      <PageHeader
        title={t('operator.title')}
        description={t('operator.description')}
        className="mb-0"
      />
      {subscriptions.isPending ? <ListSkeleton rows={3} /> : null}
      {subscriptions.isError ? (
        <ErrorState
          error={subscriptions.error}
          onRetry={() => {
            void subscriptions.refetch();
          }}
        />
      ) : null}
      {subscriptions.isSuccess && subscriptions.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('operator.none')}</p>
      ) : null}
      {subscriptions.isSuccess && subscriptions.data.length > 0 ? (
        <ul aria-label={t('operator.caption')} className="grid min-w-0 gap-3 lg:grid-cols-2">
          {subscriptions.data.map((subscription) => (
            <SubscriptionRow
              key={subscription.id}
              subscription={subscription}
              tenant={names.get(subscription.id)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
