import type { TFunction } from 'i18next';

import { isApiError } from '../../../shared/lib/api-client.js';
import { translateApiKey } from '../../../shared/lib/translate.js';

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
