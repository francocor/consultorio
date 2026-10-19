import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The one-time code of the portal (design 4.5, ADR-008): six digits, ten minutes, five wrong
 * attempts, at most three sends per address per hour. The limits are the ones of the public
 * booking's codes; the two modules keep their own copy of the rules so neither reaches into the
 * other.
 */
export const PORTAL_CODE_LIFETIME_MS = 10 * 60_000;
export const PORTAL_CODE_ATTEMPTS = 5;
export const PORTAL_CODE_SENDS_PER_HOUR = 3;

/**
 * How many times one address may try codes in a window, whatever the codes were, before the portal
 * stops answering for that address (a lock that applies to existing and unknown addresses alike, so
 * it reveals nothing). A person who types a code wrong a few times is far below it.
 */
export const PORTAL_VERIFY_ATTEMPTS = 10;
export const PORTAL_VERIFY_WINDOW_MS = 15 * 60_000;

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

/** The key of the counters of an address: a hash, so no address sits in the counter store. */
export function addressKey(tenantId: string, email: string): string {
  return createHash('sha256').update(`${tenantId}|${email.trim().toLowerCase()}`).digest('hex');
}
