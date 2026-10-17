import { useTranslation } from 'react-i18next';

/** Correct: every visible string comes from the catalog; symbols and spaces are not text. */
export function TranslatedText() {
  const { t } = useTranslation();
  return (
    <div>
      <button type="button" title={t('action.save')}>
        {t('action.save')}
      </button>
      <span aria-hidden="true">·</span> <span>{'/'}</span>
    </div>
  );
}
