import { randomBytes } from 'node:crypto';

/** Letters and digits without the ones that look alike (0/O, 1/I). */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_GROUPS = 6;
const RECOVERY_GROUP_SIZE = 5;

/** `ABCDE-FGHJK-...`: 6 groups of 5, 150 bits. */
export function generateRecoveryKey(random: (size: number) => Buffer = randomBytes): string {
  const groups: string[] = [];
  for (let group = 0; group < RECOVERY_GROUPS; group += 1) {
    let text = '';
    while (text.length < RECOVERY_GROUP_SIZE) {
      // 224 is the largest multiple of 32 under 256, so every letter is equally likely.
      for (const byte of random(16)) {
        if (byte < 224 && text.length < RECOVERY_GROUP_SIZE) {
          text += RECOVERY_ALPHABET.charAt(byte % RECOVERY_ALPHABET.length);
        }
      }
    }
    groups.push(text);
  }
  return groups.join('-');
}

/** The recovery key as typed: without dashes or spaces, upper case. */
export function normalizeRecoveryKey(typed: string): string {
  return typed.replace(/[\s-]/g, '').toUpperCase();
}

/** A typed key in its usual form, `ABCDE-FGHJK-...`. */
export function formatRecoveryKey(typed: string): string {
  const plain = normalizeRecoveryKey(typed);
  return (plain.match(/.{1,5}/g) ?? []).join('-');
}
