import { createHash, randomInt } from 'node:crypto';

export const RECOVERY_CODE_COUNT = 10;

/** 31 symbols without 0, 1, i, l, o: nothing that is easy to misread when copied by hand. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const GROUPS = 4;
const GROUP_LENGTH = 4;
const CODE_LENGTH = GROUPS * GROUP_LENGTH;

function oneCode(): string {
  const characters = Array.from(
    { length: CODE_LENGTH },
    () => ALPHABET[randomInt(ALPHABET.length)],
  );
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i += 1) {
    groups.push(characters.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH).join(''));
  }
  return groups.join('-');
}

/**
 * New recovery codes: about 79 bits each (16 symbols of 31), shown to the user once. At that
 * entropy a plain SHA-256 at rest is enough: a stolen table cannot be searched.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(oneCode());
  return [...codes];
}

/** The canonical form of what a user typed, or null if it cannot be a recovery code. */
export function normalizeRecoveryCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toLowerCase();
  if (code.length !== CODE_LENGTH) return null;
  return Array.from(code).every((character) => ALPHABET.includes(character)) ? code : null;
}

export function hashRecoveryCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}
