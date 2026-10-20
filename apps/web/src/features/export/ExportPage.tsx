import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { PageHeader } from '../../shared/ui/page-header.js';

import { PackagePanel } from './components/PackagePanel.js';

/**
 * The administrative package of the cancellation export, for the owner: the organization, its staff,
 * the patients and their coverage, the agenda, the charges and invoices and the audit log, as a PDF
 * summary and structured data. It holds nothing clinical: each professional receives their own
 * records separately, and the records of a professional who left stay in the platform's custody.
 * Available while the organization is cancelling, read-only or cancelled.
 */
export function ExportPage() {
  const { t } = useTranslation('export');
  return (
    <div className="grid gap-6">
      <PageHeader title={t('title')} description={t('administrative.description')} />
      <Alert tone="info">
        <AlertDescription>{t('administrative.notice')}</AlertDescription>
      </Alert>
      <PackagePanel audience="administrative" />
    </div>
  );
}
