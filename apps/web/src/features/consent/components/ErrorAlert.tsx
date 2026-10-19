import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../shared/lib/api-client.js';
import { describeError, translateApiKey } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';

/**
 * What went wrong, in words a person can act on: the message of the error code the server
 * answered (an expired request says so, a missing acceptance says so), or the refused fields.
 * Nothing is shown while there is no error.
 */
export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error === null || error === undefined) return null;
  const fields = isApiError(error)
    ? error.fieldErrors.map((field) => translateApiKey(t, field.i18nKey))
    : [];
  return (
    <Alert tone="danger">
      <AlertDescription>
        {fields.length > 0 ? [...new Set(fields)].join(' ') : describeError(t, error).message}
      </AlertDescription>
    </Alert>
  );
}
