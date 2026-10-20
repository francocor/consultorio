import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The one-time code of the portal (design 4.5, ADR-008): six digits, ten minutes, five wrong
 * attempts, at most three sends per address per hour. The limits are the ones of the public
 * booking's codes; the two modules keep their own copy of the rules so neither reaches into the
 * other.
 */
export const PORTAL_CODE_LIFETIME_MS = 10 * 60_000;
/**
 * The wrong tries one CLIENT has at a code (JD-S5 R2-4). A try is counted for the challenge and the
 * client that made it, so a stranger who knows an address and spends its five tries burns nothing
 * for the patient, who tries from somewhere else.
 */
export const PORTAL_CODE_ATTEMPTS = 5;
/**
 * The wrong tries a code takes from ALL clients together, after which it is spent. Without a cap
 * a crowd of clients (or one that changes address) could guess a six digit code within its life.
 */
export const PORTAL_CODE_ATTEMPTS_PER_CHALLENGE = 20;
export const PORTAL_CODE_SENDS_PER_HOUR = 3;
/**
 * The decoys one address may have in an hour (JD-S5 R3-1), counted among decoys only. A decoy is
 * written so that the answer takes the same time; above this many the answer is the same and
 * nothing is written, so several clients (or a store that fails) cannot fill `otp_challenge` and the
 * queue by naming one address.
 */
export const PORTAL_DECOYS_PER_HOUR = 3;
/**
 * The codes one client may ask for in an hour, whatever the addresses (JD-S5 R2-4). A person asks for
 * at most three (the sends of an address); a household behind one address asks for a few more.
 */
export const PORTAL_CODE_REQUESTS_PER_CLIENT = 6;
export const PORTAL_CODE_REQUESTS_WINDOW_MS = 3_600_000;

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

/** Who a client is, as a counter key: a hash, so no address of a visitor sits in the counter store. */
function clientKey(client: string | null): string {
  return createHash('sha256')
    .update(client ?? 'unknown')
    .digest('hex')
    .slice(0, 24);
}

/** The key of the tries ONE client has at ONE challenge (JD-S5 R2-4). */
export function challengeTriesKey(challengeId: string, client: string | null): string {
  return `${challengeId}|${clientKey(client)}`;
}

/** The key of the codes one client asks for in an organization (JD-S5 R2-4). */
export function requestsKey(tenantId: string, client: string | null): string {
  return `${tenantId}|${clientKey(client)}`;
}

/**
 * The key of the lock on the tries to use a code: the address AND who is trying (JD-S5 R1-S5-9).
 * Keyed by the address alone, anyone who knows an email could spend its tries and lock the patient
 * out of the portal for the window. Brute force is already bounded by the challenge itself (five
 * wrong tries spend the code, three codes an hour per address), so the lock only has to stop a
 * client that keeps trying, and that client is the one it locks. Nothing in it tells whether the
 * address has an account.
 */
export function triesKey(tenantId: string, email: string, client: string | null): string {
  return `${addressKey(tenantId, email)}|${clientKey(client)}`;
}
