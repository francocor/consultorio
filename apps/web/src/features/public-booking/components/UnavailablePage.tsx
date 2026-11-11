import { LinkIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePageTitle } from '../../../app/use-page-title.js';

/**
 * The page for an address that does not work: never existed, disabled, regenerated, expired or an
 * organization that is read-only. It is the same for all of them, so it says nothing about which one
 * it was, nor whether the organization exists.
 */
export function UnavailablePage() {
  const { t } = useTranslation('booking');
  usePageTitle(t('unavailable.title'));
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center">
      <span className="grid size-12 place-content-center rounded-full bg-muted text-muted-foreground">
        <LinkIcon className="size-6" aria-hidden="true" />
      </span>
      <h1 className="font-display text-xl font-semibold tracking-tight">
        {t('unavailable.title')}
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">{t('unavailable.description')}</p>
    </div>
  );
}
