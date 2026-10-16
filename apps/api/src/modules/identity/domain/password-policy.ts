import { readFile } from 'node:fs/promises';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordIssue,
} from '@consultorio/contracts';

export {
  PASSWORD_ISSUES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordIssue,
} from '@consultorio/contracts';

/** Local parts shorter than this are too ambiguous to compare against the password. */
const MIN_EMAIL_PART = 4;

export type PasswordCheck = { ok: true } | { ok: false; issues: PasswordIssue[] };

export interface PasswordContext {
  /** The account's email: a password built from it is easy to guess. */
  email?: string;
}

export interface PasswordPolicy {
  check(password: string, context?: PasswordContext): PasswordCheck;
}

const MESSAGES_ES_AR: Record<PasswordIssue, string> = {
  too_short: `La contraseña debe tener al menos ${String(PASSWORD_MIN_LENGTH)} caracteres. Probá con una frase larga.`,
  too_long: `La contraseña no puede superar los ${String(PASSWORD_MAX_LENGTH)} caracteres.`,
  common:
    'Esa contraseña es muy común y es de las primeras que se prueban en un ataque. Elegí otra o armá una frase propia.',
  repeated_character:
    'La contraseña no puede ser un solo carácter repetido. Elegí una frase fácil de recordar pero difícil de adivinar.',
  contains_email: 'La contraseña no puede contener tu correo electrónico. Elegí otra.',
  breached: 'Esa contraseña apareció en filtraciones de datos conocidas. Elegí otra distinta.',
};

export interface DescribedIssue {
  code: PasswordIssue;
  /** Translation key for the web app. */
  i18nKey: string;
  /** Default es-AR text, for clients that do not translate. */
  message: string;
}

export function describePasswordIssues(issues: readonly PasswordIssue[]): DescribedIssue[] {
  return issues.map((code) => ({
    code,
    i18nKey: `auth.password.${code}`,
    message: MESSAGES_ES_AR[code],
  }));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Turns the text of a password list (one entry per line) into a set of normalized entries. */
export function parseCommonPasswords(text: string): Set<string> {
  const entries = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const entry = normalize(line);
    if (entry !== '') entries.add(entry);
  }
  return entries;
}

/**
 * Reads the bundled list. The list is held by the platform itself: a candidate password is never
 * sent to a third party for this check (identity-access, "Password policy").
 */
export async function loadCommonPasswords(path: string): Promise<Set<string>> {
  return parseCommonPasswords(await readFile(path, 'utf8'));
}

function isOneRepeatedCharacter(characters: readonly string[]): boolean {
  const first = characters[0];
  return first !== undefined && characters.every((character) => character === first);
}

/**
 * Builds the password policy over a list of common passwords. Pure: the same input always gives
 * the same answer, and nothing about the password is logged or stored.
 *
 * Length is counted in characters, and is checked first: a password of the wrong length is
 * reported by length alone. The comparison with the list ignores case and surrounding spaces.
 */
export function createPasswordPolicy(common: ReadonlySet<string>): PasswordPolicy {
  return {
    check(password, context = {}) {
      const characters = Array.from(password);
      if (characters.length < PASSWORD_MIN_LENGTH) return { ok: false, issues: ['too_short'] };
      if (characters.length > PASSWORD_MAX_LENGTH) return { ok: false, issues: ['too_long'] };

      const issues: PasswordIssue[] = [];
      if (isOneRepeatedCharacter(characters)) issues.push('repeated_character');
      else if (common.has(normalize(password))) issues.push('common');

      const localPart = normalize(context.email?.split('@')[0] ?? '');
      if (localPart.length >= MIN_EMAIL_PART && normalize(password).includes(localPart)) {
        issues.push('contains_email');
      }

      return issues.length === 0 ? { ok: true } : { ok: false, issues };
    },
  };
}

/** Checks a password against a list of breached ones. Optional; see `breached-passwords.ts`. */
export interface BreachCheck {
  isBreached(password: string): Promise<boolean>;
}

export interface PasswordValidator {
  validate(password: string, context?: PasswordContext): Promise<PasswordCheck>;
}

/**
 * The local policy first (always on, nothing leaves the server), then, only for a password it
 * accepted, the optional breach check. The breach check never blocks when its provider is down.
 */
export function createPasswordValidator(
  policy: PasswordPolicy,
  breach?: BreachCheck,
): PasswordValidator {
  return {
    async validate(password, context) {
      const local = policy.check(password, context);
      if (!local.ok || !breach) return local;
      return (await breach.isBreached(password)) ? { ok: false, issues: ['breached'] } : local;
    },
  };
}
