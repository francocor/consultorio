import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { useMe } from '../../../../app/session.js';
import { formatDate } from '../../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Button } from '../../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../../shared/ui/card.js';
import {
  goToProviderPage,
  subscriptionApi,
  subscriptionKeys,
} from '../../../subscription/index.js';

/**
 * The trial of a new organization, in the setup wizard (tenant-onboarding, "Trial and payment on
 * signup"): when it ends and what happens then, and a way to subscribe the same day. Paying is never
 * required to go on: when the payments provider cannot be reached the wizard says so and that the
 * payment can be completed later from "Suscripción". It shows nothing for anyone but the owner, for an
 * organization without a subscription (a demo, a deployment billed outside the platform), for one that
 * is past its trial, or when the subscription cannot be read: the wizard never waits for it.
 */
export function TrialCard() {
  const { t } = useTranslation(['signup', 'common']);
  const api = useApi();
  const canBill = useMe().permissions.includes('billing.manage');
  const view = useQuery({
    queryKey: subscriptionKeys.view,
    queryFn: () => subscriptionApi(api).view(),
    enabled: canBill,
    retry: false,
  });
  const authorize = useMutation({
    mutationFn: () => subscriptionApi(api).checkout(),
    onSuccess: (result) => {
      goToProviderPage(result.checkoutUrl);
    },
  });

  const subscription = view.data?.subscription;
  if (!canBill || !subscription || subscription.status !== 'trial') return null;
  const authorized = subscription.authorization === 'authorized';

  return (
    <Card aria-labelledby="trial-title">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Clock className="size-5 text-primary-ink" aria-hidden="true" />
          <CardTitle id="trial-title" as="h2">
            {t('signup:trial.title')}
          </CardTitle>
        </div>
        <CardDescription>
          {t('signup:trial.ends', { date: formatDate(subscription.trialEndsAt) })}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>{t('signup:trial.consequence', { days: subscription.plan.graceDays })}</p>
        {authorized ? (
          <p className="text-muted-foreground">{t('signup:trial.authorized')}</p>
        ) : (
          <>
            <p className="text-muted-foreground">{t('signup:trial.later')}</p>
            {authorize.isError ? (
              <Alert tone="warning">
                <AlertDescription>
                  {t('signup:trial.unavailable')}{' '}
                  <Link to="/subscription" className="font-medium underline">
                    {t('signup:trial.laterLink')}
                  </Link>
                </AlertDescription>
              </Alert>
            ) : null}
            <div>
              <Button
                type="button"
                variant="outline"
                loading={authorize.isPending}
                onClick={() => {
                  authorize.mutate();
                }}
              >
                {t('signup:trial.subscribe')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
