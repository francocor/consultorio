import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Sets the browser title of a page of the platform host: "Section · Product". There is no
 * organization there to name (`usePageTitle` asks the organization's boot document, which the
 * platform host does not have).
 */
export function usePlatformTitle(section: string): void {
  const { t } = useTranslation('shell');
  const product = t('platform.title');
  useEffect(() => {
    const previous = document.title;
    document.title = `${section} · ${product}`;
    return () => {
      document.title = previous;
    };
  }, [section, product]);
}
