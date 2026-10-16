import type { FieldPath, FieldValues, UseFormReturn } from 'react-hook-form';

import { isApiError } from './api-client.js';

/**
 * Puts the field errors of a rejected request next to the fields they name. The message stored is
 * the translation key the API sent; `FormMessage` translates it when it renders.
 *
 * Returns true when at least one error was placed, so the caller knows whether the screen already
 * explains the failure (and a generic banner is not needed).
 */
export function applyApiFieldErrors<T extends FieldValues>(
  form: UseFormReturn<T>,
  error: unknown,
): boolean {
  if (!isApiError(error) || error.fieldErrors.length === 0) return false;
  for (const fieldError of error.fieldErrors) {
    form.setError(fieldError.path as FieldPath<T>, {
      type: 'server',
      message: fieldError.i18nKey,
    });
  }
  return true;
}
