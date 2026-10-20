import { createHash } from 'node:crypto';

import { clientKeyOf } from '../../../../platform/http/rate-limit.js';

/** How often a visitor, an address and the whole platform may ask for signups (counters, per hour). */
export interface SignupLimit {
  max: number;
  windowMs: number;
}

const HOUR = 3_600_000;

/**
 * The counters of the public form, on top of the limit per client that every route has:
 *
 * - per client: a person at one connection creates a handful of organizations an hour, not hundreds
 *   (an unverified organization holds a name and a row for seven days);
 * - per address: three emails an hour to any one address, whatever the request was (a signup, a new
 *   link), so the form cannot be used to flood somebody's inbox. It counts the addresses that have
 *   an account and the ones that do not alike, so being throttled tells nothing about anyone;
 * - overall: a ceiling for the whole platform, so a distributed flood cannot fill the table.
 *
 * Counters are best effort (a store that fails does not close the form); the bot challenge and the
 * purge are what bound the rest.
 */
export const SIGNUPS_PER_CLIENT: SignupLimit = { max: 5, windowMs: HOUR };
/**
 * Asking for a new link has a counter of its own per client, apart from the one of signups: a person
 * who mistyped an address or lost an email asks again a few times and must not run out of signups.
 */
export const LINKS_PER_CLIENT: SignupLimit = { max: 10, windowMs: HOUR };
export const SIGNUP_EMAILS_PER_ADDRESS: SignupLimit = { max: 3, windowMs: HOUR };
export const SIGNUPS_OVERALL: SignupLimit = { max: 300, windowMs: HOUR };

/** The counter of a client; clients of one IPv6 /64 are one client. */
export function clientCounter(ip: string | null, kind: 'signup' | 'link' = 'signup'): string {
  return `signup|${kind === 'signup' ? 'client' : 'link-client'}|${clientKeyOf(ip ?? 'unknown')}`;
}

/** The counter of an address: a hash of it, never the address, so the store holds no personal data. */
export function addressCounter(email: string): string {
  const digest = createHash('sha256').update(`signup|${email.trim().toLowerCase()}`).digest('hex');
  return `signup|address|${digest.slice(0, 32)}`;
}

export const OVERALL_COUNTER = 'signup|overall';
