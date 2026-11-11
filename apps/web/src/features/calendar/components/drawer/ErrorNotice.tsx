import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../../shared/lib/api-client.js';
import { describeError, translateApiKey } from '../../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';

/**
 * What went wrong with an action, in words a person can act on. A stale version says the
 * appointment changed meanwhile (and the drawer has already reloaded it); a validation refusal
 * names the rule; anything else uses the standard messages.
 */
export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation(['scheduling']);
  if (error === null || error === undefined) return null;

  let messages: string[];
  if (isApiError(error) && error.code === 'stale_revision') {
    messages = [t('scheduling:drawer.stale')];
  } else if (isApiError(error) && error.fieldErrors.length > 0) {
    messages = error.fieldErrors.map((field) => translateApiKey(t, field.i18nKey));
  } else {
    messages = [describeError(t, error).message];
  }

  return (
    <Alert tone="danger">
      <AlertDescription>
        {messages.map((message) => (
          <span key={message} className="block">
            {message}
          </span>
        ))}
      </AlertDescription>
    </Alert>
  );
}
