import { Pill } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../shared/ui/page-header.js';

/**
 * Seam stub of Stage 5: the screen of the professional's prescriptions. The e-Rx track (A3, S5.05)
 * replaces it with the list, the issue form and the states of the provider.
 */
export function PrescriptionsPage() {
  const { t } = useTranslation('prescriptions');
  return (
    <div>
      <PageHeader title={t('title')} description={t('stub.description')} />
      <Pill className="size-10 text-primary-ink" aria-hidden="true" />
    </div>
  );
}
