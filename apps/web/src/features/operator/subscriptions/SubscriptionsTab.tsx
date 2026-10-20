import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../../shared/ui/page-header.js';

/**
 * Seam stub of Stage 6: the subscriptions tab of the operator console. The subscriptions track (A,
 * S6.07) replaces it with the state, the usage counts and the surplus flags of each organization,
 * and the support view, which shows no patient or clinical data.
 */
export function SubscriptionsTab() {
  const { t } = useTranslation('subscription');
  return <PageHeader title={t('operator.title')} description={t('operator.stub.description')} />;
}
