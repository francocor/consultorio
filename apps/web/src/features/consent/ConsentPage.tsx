import { FileSignature } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../shared/ui/page-header.js';

/**
 * Seam stub of Stage 5: the template manager. The consent track (A2, S5.11) replaces it with the
 * drafts, the published versions and the starters.
 */
export function ConsentPage() {
  const { t } = useTranslation('consent');
  return (
    <div>
      <PageHeader title={t('title')} description={t('stub.description')} />
      <FileSignature className="size-10 text-primary-ink" aria-hidden="true" />
    </div>
  );
}
