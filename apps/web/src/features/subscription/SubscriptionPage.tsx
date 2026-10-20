import { CreditCard } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../shared/ui/page-header.js';

/**
 * Seam stub of Stage 6: the subscription of the organization, for the owner. The subscriptions
 * track (A, S6.07) replaces it with the plan, the state and its dates, the usage per professional,
 * the statements, the overage cap, and the cancel and reactivate actions.
 */
export function SubscriptionPage() {
  const { t } = useTranslation('subscription');
  return (
    <div>
      <PageHeader title={t('title')} description={t('stub.description')} />
      <CreditCard className="size-10 text-primary-ink" aria-hidden="true" />
    </div>
  );
}
