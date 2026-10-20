import { PackageOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../shared/ui/page-header.js';

/**
 * Seam stub of Stage 6: the administrative package of the cancellation export, for the owner. The
 * retention track (C, S6.36) replaces it with the package, its state and its download.
 */
export function ExportPage() {
  const { t } = useTranslation('export');
  return (
    <div>
      <PageHeader title={t('title')} description={t('stub.description')} />
      <PackageOpen className="size-10 text-primary-ink" aria-hidden="true" />
    </div>
  );
}
