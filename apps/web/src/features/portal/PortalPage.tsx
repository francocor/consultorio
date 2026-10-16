import { Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PageHeader } from '../../shared/ui/page-header.js';

/** Scaffold of the patient portal; its content arrives with the portal capability. */
export function PortalPage() {
  const { t } = useTranslation('shell');
  return (
    <div>
      <PageHeader title={t('portal.title')} description={t('portal.description')} />
      <Heart className="size-10 text-primary-ink" aria-hidden="true" />
    </div>
  );
}
