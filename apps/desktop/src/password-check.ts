import { readFileSync } from 'node:fs';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordIssue,
} from '@consultorio/contracts';

/**
 * The password rules of the product, so the setup screen tells the owner what is wrong before anything
 * starts, with the same words the web app uses. The API enforces them again (`provision` and
 * `reset-password` answer `password_rejected`), and a test checks this file gives the same verdicts as
 * `apps/api/src/modules/identity/domain/password-policy.ts`.
 */

/** The messages of `apps/web/src/locales/es-AR/auth.json` (a test checks they have not drifted). */
export const PASSWORD_MESSAGES: Record<PasswordIssue, string> = {
  too_short: `La contraseña debe tener al menos ${String(PASSWORD_MIN_LENGTH)} caracteres. Una frase larga es una buena opción.`,
  too_long: `La contraseña no puede superar los ${String(PASSWORD_MAX_LENGTH)} caracteres.`,
  common:
    'Esa contraseña es muy común y se prueba primero en los ataques. Elija otra o arme una frase propia.',
  repeated_character:
    'La contraseña no puede ser un solo carácter repetido. Elija una frase fácil de recordar y difícil de adivinar.',
  contains_email: 'La contraseña no puede contener su correo electrónico. Elija otra.',
  breached: 'Esa contraseña apareció en filtraciones de datos conocidas. Elija otra distinta.',
};

const KNOWN_ISSUES = new Set<string>(Object.keys(PASSWORD_MESSAGES));

/** Local parts shorter than this are too ambiguous to compare against the password. */
const MIN_EMAIL_PART = 4;

const normalize = (value: string) => value.trim().toLowerCase();

/** Turns the text of the password list (one entry per line) into a set of normalized entries. */
export function parseCommonPasswords(text: string): Set<string> {
  const entries = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const entry = normalize(line);
    if (entry !== '') entries.add(entry);
  }
  return entries;
}

export function loadCommonPasswordsSync(path: string): Set<string> {
  return parseCommonPasswords(readFileSync(path, 'utf8'));
}

export function checkPassword(
  password: string,
  email: string,
  common: ReadonlySet<string>,
): PasswordIssue[] {
  const characters = Array.from(password);
  if (characters.length < PASSWORD_MIN_LENGTH) return ['too_short'];
  if (characters.length > PASSWORD_MAX_LENGTH) return ['too_long'];
  const issues: PasswordIssue[] = [];
  const first = characters[0];
  if (characters.every((character) => character === first)) issues.push('repeated_character');
  else if (common.has(normalize(password))) issues.push('common');
  const localPart = normalize(email.split('@')[0] ?? '');
  if (localPart.length >= MIN_EMAIL_PART && normalize(password).includes(localPart)) {
    issues.push('contains_email');
  }
  return issues;
}

/** The message for each issue the API reported; an issue this version does not know gets the generic text. */
export function messagesForIssues(issues: readonly string[]): string[] {
  const known = issues.filter((issue): issue is PasswordIssue => KNOWN_ISSUES.has(issue));
  return known.map((issue) => PASSWORD_MESSAGES[issue]);
}
