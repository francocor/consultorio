import { useQuery } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDateTime, formatMoney } from '../../../shared/lib/format.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { billingApi, billingKeys } from '../api/billing-api.js';

/**
 * What each payer owes the organization (the payer lines of the charges that are not voided). A
 * payment of the patient never reduces it: the payer is billed outside the system, with the payer
 * settlement export.
 */
export function ReceivablesPanel({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation('billing');
  const api = useApi();
  const receivables = useQuery({
    queryKey: billingKeys.receivables(from, to),
    queryFn: () => billingApi(api).receivables(from, to),
  });

  if (receivables.isPending) return <ListSkeleton rows={3} />;
  if (receivables.isError) {
    return (
      <ErrorState
        error={receivables.error}
        onRetry={() => {
          void receivables.refetch();
        }}
      />
    );
  }
  if (receivables.data.groups.length === 0) {
    return (
      <EmptyState
        icon={Landmark}
        title={t('receivables.empty.title')}
        description={t('receivables.empty.description')}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('receivables.note')}</p>
      <ul className="grid gap-3">
        {receivables.data.groups.map((group) => (
          <li key={group.tenantPayerId} className="rounded-lg border bg-card p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="font-display text-base font-semibold">{group.payerName}</h3>
              <span className="tabular-nums text-base font-semibold">
                {formatMoney(group.totalCents)}
              </span>
            </div>
            <ul className="mt-2 grid gap-1 text-sm">
              {group.items.map((item) => (
                <li
                  key={`${item.chargeId}-${item.startsAt}`}
                  className="flex justify-between gap-3"
                >
                  <span className="min-w-0 truncate">
                    {item.patientName} · {item.appointmentTypeName} ·{' '}
                    {formatDateTime(item.startsAt)}
                  </span>
                  <span className="tabular-nums">{formatMoney(item.amountCents)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="flex justify-between text-sm font-semibold">
        <span>{t('receivables.total')}</span>
        <span className="tabular-nums">{formatMoney(receivables.data.totalCents)}</span>
      </p>
    </div>
  );
}
