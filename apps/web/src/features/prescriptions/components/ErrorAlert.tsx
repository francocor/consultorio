import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../shared/lib/api-client.js';
import { describeError, translateApiKey } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';

/** The message the server gave for one field of a request, translated, or null. */
export function serverFieldMessage(error: unknown, path: string, t: TFunction): string | null {
  if (!isApiError(error)) return null;
  const found = error.fieldErrors.find((field) => field.path === path);
  return found ? translateApiKey(t, found.i18nKey) : null;
}

/** True when the failure is about the fields of the form, which are shown next to them. */
export function isFieldFailure(error: unknown): boolean {
  return isApiError(error) && error.fieldErrors.length > 0;
}

/**
 * What went wrong, in words a person can act on: the refusal of the provider, an unverified
 * registration, a patient without a document. Nothing is shown while there is no error, and a
 * failure about the fields is shown next to them instead.
 */
export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error === null || error === undefined || isFieldFailure(error)) return null;
  return (
    <Alert tone="danger">
      <AlertDescription>{describeError(t, error).message}</AlertDescription>
    </Alert>
  );
}
