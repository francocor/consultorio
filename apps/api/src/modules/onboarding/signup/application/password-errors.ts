import type { FieldError, PasswordIssue } from '@consultorio/contracts';

/**
 * The field errors of a rejected password, as the problem response carries them: the path of the
 * field and a translation key per reason (the same keys sign-in, invitations and resets use). The
 * submitted password is never echoed.
 */
export function passwordFieldErrors(issues: readonly PasswordIssue[]): FieldError[] {
  return issues.map((issue) => ({ path: 'password', i18nKey: `auth.password.${issue}` }));
}
