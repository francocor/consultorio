import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { PageHeader } from '../../shared/ui/page-header.js';

import { PackagePanel } from './components/PackagePanel.js';

/**
 * The clinical package of a professional: the records of the patients they attend (entries and their
 * addenda, anamnesis, clinical documents, prescriptions and consents). It is personal: only the
 * professional it was made for can download it, and it never goes to the owner or an administrator.
 */
export function ClinicalExportPage() {
  const { t } = useTranslation('export');
  return (
    <div className="grid gap-6">
      <PageHeader title={t('clinical.title')} description={t('clinical.description')} />
      <Alert tone="info">
        <AlertDescription>{t('clinical.notice')}</AlertDescription>
      </Alert>
      <PackagePanel audience="clinical" />
    </div>
  );
}
