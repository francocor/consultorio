import { PackageOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../shared/ui/page-header.js';

/**
 * Seam stub of Stage 6: the clinical package of a professional, with the records of their own
 * patients. The retention track (C, S6.36) replaces it with the package, its state and its download.
 */
export function ClinicalExportPage() {
  const { t } = useTranslation('export');
  return (
    <div>
      <PageHeader title={t('clinical.title')} description={t('clinical.stub.description')} />
      <PackageOpen className="size-10 text-primary-ink" aria-hidden="true" />
    </div>
  );
}
