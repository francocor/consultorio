import { type Money } from '@consultorio/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { formatMoney } from '../../shared/lib/format.js';
import { Button } from '../../shared/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../shared/ui/card.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { DetailSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { subscriptionApi, subscriptionKeys } from './api/subscription-api.js';
import { ErrorNotice } from './components/ErrorNotice.js';
import { PlanCard } from './components/PlanCard.js';
import { SimulatedPaymentsNotice } from './components/SimulatedPaymentsNotice.js';
import { StatementsCard } from './components/StatementsCard.js';
import { UsageCard } from './components/UsageCard.js';
import { goToProviderPage } from './domain/provider-page.js';

/** An account that has no subscription yet: the plan it would start on, and the way to authorize the payment. */
function StartCard({ plan }: { plan: { name: string; pricePerProfessionalCents: number } }) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const authorize = useMutation({
    mutationFn: () => subscriptionApi(api).checkout(),
    onSuccess: (result) => {
      goToProviderPage(result.checkoutUrl);
    },
  });
  return (
    <Card aria-labelledby="start-title">
      <CardHeader>
        <CardTitle id="start-title">{t('start.title')}</CardTitle>
        <CardDescription>{t('start.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm">
          <span className="font-medium">{plan.name}</span>
          {' · '}
          {t('plan.price', { price: formatMoney(plan.pricePerProfessionalCents as Money) })}
        </p>
        <ErrorNotice error={authorize.error} />
        <div>
          <Button
            type="button"
            loading={authorize.isPending}
            onClick={() => {
              authorize.mutate();
            }}
          >
            {t('action.authorize')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The subscription of the organization, for its owner (`billing.manage`): the plan and the state with
 * the date of the next change, what is charged and when, the WhatsApp usage with the overage cap, and
 * the statements. A demo or a deployment that bills outside the platform has no subscription and says
 * so; a payments simulator says it is one.
 */
export function SubscriptionPage() {
  const { t } = useTranslation('subscription');
  usePageTitle(t('title'));
  const api = useApi();
  const view = useQuery({
    queryKey: subscriptionKeys.view,
    queryFn: () => subscriptionApi(api).view(),
  });

  if (view.isPending) {
    return (
      <div>
        <PageHeader title={t('title')} description={t('description')} />
        <DetailSkeleton />
      </div>
    );
  }
  if (view.isError) {
    return (
      <div>
        <PageHeader title={t('title')} description={t('description')} />
        <ErrorState
          error={view.error}
          onRetry={() => {
            void view.refetch();
          }}
        />
      </div>
    );
  }

  const { exempt, subscription, plan, simulated } = view.data;
  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      {simulated ? <SimulatedPaymentsNotice /> : null}

      {exempt ? (
        <Card aria-labelledby="exempt-title">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ReceiptText className="size-5 text-primary-ink" aria-hidden="true" />
              <CardTitle id="exempt-title">{t('exempt.title')}</CardTitle>
            </div>
            <CardDescription>{t('exempt.description')}</CardDescription>
          </CardHeader>
        </Card>
      ) : subscription === null ? (
        plan === null ? null : (
          <StartCard plan={plan} />
        )
      ) : (
        <>
          <PlanCard subscription={subscription} />
          <UsageCard />
          <StatementsCard />
        </>
      )}
    </div>
  );
}
