import { z } from 'zod';

/**
 * Zod's default messages are English sentences. Forms show translated text, so by default every
 * issue carries a translation key (`validation.*`) that `FormMessage` resolves through i18n. A
 * schema that writes its own message on purpose (a key such as `country.ar.national_id.invalid`)
 * keeps it.
 */
export function installZodMessages(): void {
  z.config({
    customError: (issue) => {
      switch (issue.code) {
        case 'invalid_type':
          return issue.input === undefined || issue.input === null
            ? 'validation.required'
            : 'validation.invalid';
        case 'too_small':
          if (issue.origin === 'string' || issue.origin === 'array') {
            return issue.minimum === 1 || issue.minimum === 1n
              ? 'validation.required'
              : 'validation.too_short';
          }
          return 'validation.too_small';
        case 'too_big':
          return issue.origin === 'string' || issue.origin === 'array'
            ? 'validation.too_long'
            : 'validation.too_big';
        case 'invalid_format':
          return issue.format === 'email' ? 'validation.email' : 'validation.format';
        default:
          return 'validation.invalid';
      }
    },
  });
}
