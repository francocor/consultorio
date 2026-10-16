/**
 * The password rules both sides know. The API enforces them (and the common-password list, which
 * only it has); the web shows them as hints before the user types, so nobody learns the rules
 * from a rejection.
 */

/** Shortest and longest accepted password, in characters (Unicode code points). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_ISSUES = [
  'too_short',
  'too_long',
  'common',
  'repeated_character',
  'contains_email',
  'breached',
] as const;
export type PasswordIssue = (typeof PASSWORD_ISSUES)[number];

/** Translation keys of the reasons a password can be rejected, as the API sends them. */
export const PASSWORD_ISSUE_KEYS: readonly string[] = PASSWORD_ISSUES.map(
  (issue) => `auth.password.${issue}`,
);
