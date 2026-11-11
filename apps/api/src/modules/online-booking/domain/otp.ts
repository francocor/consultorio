import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** One-time codes of the public flows (online-booking, "Abuse protection"). */
export const CODE_LIFETIME_MS = 10 * 60_000;
export const CODE_ATTEMPTS = 5;
export const CODE_SENDS_PER_HOUR = 3;

/** Six digits, zeros included. `random` is `crypto.randomInt` unless a test supplies a source. */
export function generateCode(random: (max: number) => number = (max) => randomInt(max)): string {
  return String(random(1_000_000)).padStart(6, '0');
}

/**
 * What is stored instead of the code: a hash tied to the challenge, so the table never holds a code
 * and the same digits hash differently for another challenge. A six digit code is small enough to
 * be searched; the protection is its ten minute life and five attempts, not the hash.
 */
export function hashCode(challengeId: string, code: string): string {
  return createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
}

/** True when the code is the one that was hashed. A challenge with no hash accepts nothing. */
export function codeMatches(challengeId: string, code: string, stored: string | null): boolean {
  if (stored === null) return false;
  const left = Buffer.from(hashCode(challengeId, code));
  const right = Buffer.from(stored);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `l***@example.test`: enough for the visitor to see they typed the right address, no more. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}
