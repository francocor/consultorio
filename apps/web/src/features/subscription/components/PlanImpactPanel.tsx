import { type Money } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatCalendarDay, formatMoney } from '../../../shared/lib/format.js';
import { Alert, AlertDescription, AlertTitle } from '../../../shared/ui/alert.js';
import { subscriptionApi, subscriptionKeys } from '../api/subscription-api.js';

const money = (cents: number) => formatMoney(cents as Money);

/**
 * What adding professionals does to the price, before the owner confirms: the new monthly cost, what
 * this month costs prorated by the day, and the limit of the plan with the way to change it. Nothing
 * is shown where no plan is affected (an account without billing, or reception and administration,
 * which are free). Only the owner can read the numbers, so only the owner is shown the panel.
 */
export function PlanImpactPanel({ professionals = 1 }: { professionals?: number }) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const impact = useQuery({
    queryKey: subscriptionKeys.impact(professionals),
    queryFn: () => subscriptionApi(api).impact(professionals),
    // A failure to look must not block an invitation: the server checks the limit again.
    retry: false,
  });
  if (!impact.isSuccess || !impact.data.affectsPlan) return null;
  const data = impact.data;

  return (
    <Alert tone={data.limit.reached ? 'warning' : 'info'}>
      <AlertTitle>{t('impact.title')}</AlertTitle>
      <AlertDescription>
        <ul className="grid gap-1">
          <li>
            {t('impact.professionals', {
              now: data.activeProfessionals.now,
              after: data.activeProfessionals.after,
            })}
          </li>
          <li>
            {t('impact.monthly', {
              now: money(data.monthlyCents.now),
              after: money(data.monthlyCents.after),
              difference: money(data.monthlyDifferenceCents),
            })}
          </li>
          <li>
            {t('impact.prorated', {
              amount: money(data.proratedThisPeriodCents),
              days: data.daysLeft,
              date: formatCalendarDay(data.periodEndsOn),
            })}
          </li>
          <li>{t('impact.limit', { max: data.limit.max })}</li>
        </ul>
        {data.limit.reached ? (
          <p className="mt-2">
            {t('impact.limitReached', { max: data.limit.max })}{' '}
            <Link to="/subscription" className="font-medium underline">
              {t('impact.plans')}
            </Link>
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
