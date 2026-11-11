import type { FieldPath, FieldValues, UseFormReturn } from 'react-hook-form';

import { isApiError } from './api-client.js';

/** How many field errors a failure carries (zero for anything that is not about a field). */
export function fieldErrorCount(error: unknown): number {
  return isApiError(error) ? error.fieldErrors.length : 0;
}

/**
 * Puts the field errors of a rejected request next to the fields they name. The message stored is
 * the translation key the API sent; `FormMessage` translates it when it renders.
 *
 * Returns true when at least one error was placed, so the caller knows whether the screen already
 * explains the failure (and a generic banner is not needed).
 *
 * `aliases` maps a path the API uses to the name of the field on the screen, for forms whose
 * fields are not shaped like the request (the API says `matricula`, the form has a number field).
 * An alias also covers the paths below it (`matricula.number`).
 */
export function applyApiFieldErrors<T extends FieldValues>(
  form: UseFormReturn<T>,
  error: unknown,
  aliases: Readonly<Record<string, string>> = {},
): boolean {
  if (!isApiError(error) || error.fieldErrors.length === 0) return false;
  for (const fieldError of error.fieldErrors) {
    const alias = Object.entries(aliases).find(
      ([from]) => fieldError.path === from || fieldError.path.startsWith(`${from}.`),
    );
    form.setError((alias ? alias[1] : fieldError.path) as FieldPath<T>, {
      type: 'server',
      message: fieldError.i18nKey,
    });
  }
  return true;
}
