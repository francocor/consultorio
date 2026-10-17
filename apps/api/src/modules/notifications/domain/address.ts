import { createHash } from 'node:crypto';

import type { MessageChannel } from '@consultorio/contracts';

/**
 * The hash that stands for an address in the message log. The log never keeps an email or a number
 * (spec "Message content and privacy"), but it must still say "this address failed for good" and
 * "this number was written to by this organization". The channel is part of the input, so an email
 * and a number never collide.
 */
export function hashAddress(channel: MessageChannel, address: string): string {
  return createHash('sha256').update(`${channel}:${address.trim().toLowerCase()}`).digest('hex');
}
