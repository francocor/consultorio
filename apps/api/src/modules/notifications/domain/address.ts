import { createHash, createHmac } from 'node:crypto';

import type { MessageChannel } from '@consultorio/contracts';

/**
 * The hash that stands for an address in the message log. The log never keeps an email or a number
 * (spec "Message content and privacy"), but it must still say "this address failed for good" and
 * "this number was written to by this organization". The channel is part of the input, so an email
 * and a number never collide.
 *
 * It is an HMAC-SHA256 keyed with a pepper that belongs to the platform (`ADDRESS_HASH_PEPPER`), not
 * a bare SHA-256: a phone number has so few possible values that anybody holding the table could
 * try them all against an unkeyed hash. The pepper is the same for every organization, because the
 * webhook has to find an organization from a number alone. A hash starts with `h2:` so it can be
 * told from the unsalted ones the log held before.
 */

const PREFIX = 'h2:';

/** Used outside production when no pepper was configured. Public on purpose: it protects nothing. */
const DEV_PEPPER = 'development-only-address-hash-pepper';

let configured: string | null = null;

/** Sets the pepper at start-up (`null` forgets it). Production refuses to hash without one. */
export function configureAddressHash(pepper: string | null): void {
  configured = pepper;
}

function pepper(): string {
  if (configured !== null) return configured;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('ADDRESS_HASH_PEPPER is not configured');
  }
  return DEV_PEPPER;
}

function normalized(channel: MessageChannel, address: string): string {
  return `${channel}:${address.trim().toLowerCase()}`;
}

export function hashAddress(channel: MessageChannel, address: string): string {
  return PREFIX + createHmac('sha256', pepper()).update(normalized(channel, address)).digest('hex');
}

/** True for a hash written before the pepper existed. */
export function isLegacyAddressHash(hash: string): boolean {
  return !hash.startsWith(PREFIX);
}

/** The unsalted hash the log used to keep: only to recognize an old row and replace it. */
export function legacyAddressHash(channel: MessageChannel, address: string): string {
  return createHash('sha256').update(normalized(channel, address)).digest('hex');
}
