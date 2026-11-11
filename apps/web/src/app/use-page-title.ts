import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useBoot } from './boot.js';

/**
 * Sets the browser title to "Section · Organization". Only fixed section names are allowed here,
 * never a patient's name or anything clinical: titles end up in the history and in shared links.
 */
export function usePageTitle(section: string): void {
  const { t } = useTranslation('shell');
  const organization = useBoot()?.name ?? t('org.fallbackName');
  useEffect(() => {
    const previous = document.title;
    document.title = `${section} · ${organization}`;
    return () => {
      document.title = previous;
    };
  }, [section, organization]);
}
