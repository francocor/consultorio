import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate, formatMoney } from '../../../shared/lib/format.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { billingApi, billingKeys } from '../api/billing-api.js';

import { ChargeStatusBadge } from './ChargeStatusBadge.js';

/** In the patient record: what has been charged to this patient, with what is still owed. */
export function PatientChargesTab({ patientId }: { patientId: string }) {
  const { t } = useTranslation('billing');
  const api = useApi();
  const filters = { patientId };
  const list = useQuery({
    queryKey: billingKeys.charges(filters),
    queryFn: () => billingApi(api).charges(filters),
  });

  if (list.isPending) return <ListSkeleton rows={3} />;
  if (list.isError) {
    return (
      <ErrorState
        error={list.error}
        onRetry={() => {
          void list.refetch();
        }}
      />
    );
  }
  if (list.data.charges.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title={t('patientCharges.empty.title')}
        description={t('patientCharges.empty.description')}
      />
    );
  }
  return (
    <ul aria-label={t('patientCharges.caption')} className="grid gap-2">
      {list.data.charges.map((charge) => (
        <li
          key={charge.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3"
        >
          <div className="min-w-0 text-sm">
            <p className="font-medium">
              {formatDate(charge.startsAt)} · {charge.appointmentTypeName}
            </p>
            <p className="text-muted-foreground">
              {t('list.total')}:{' '}
              <span className="tabular-nums">{formatMoney(charge.totalCents)}</span> ·{' '}
              {t('list.outstanding')}:{' '}
              <span className="tabular-nums">{formatMoney(charge.outstandingCents)}</span>
            </p>
          </div>
          <ChargeStatusBadge status={charge.status} />
        </li>
      ))}
    </ul>
  );
}
