import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../../shared/ui/page-header.js';

/**
 * Seam stub of Stage 6: the archive tab of the operator console. The retention track (C, S6.41)
 * replaces it with the requests to release archived records: recording one, verifying the identity
 * of the requester out of band, and approving. It never shows the content of the archive.
 */
export function ArchiveTab() {
  const { t } = useTranslation('export');
  return <PageHeader title={t('operator.title')} description={t('operator.stub.description')} />;
}
