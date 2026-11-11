import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../../platform/http/problem.js';
import type { RateLimit, RateLimitStore } from '../../../platform/http/rate-limit.js';

/**
 * How often one professional may search the text of a record (design 4.3). A search decrypts up to
 * the whole record of a patient, so it is the one clinical read worth a cap of its own: the limit
 * is per user (not per address, which a shared clinic network would make useless) and counted apart
 * from the general limits of the API.
 */
export const DEFAULT_SEARCH_LIMIT: RateLimit = { max: 30, windowMs: 60_000 };

export interface SearchLimitSettings {
  store: RateLimitStore;
  limit?: RateLimit | undefined;
}

/** A route hook that answers 429 with Retry-After once the user has used up the allowance. */
export function searchRateLimit(settings: SearchLimitSettings) {
  const limit = settings.limit ?? DEFAULT_SEARCH_LIMIT;
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const actor = request.actor;
    if (!actor) return;
    let state: { count: number; resetsInMs: number };
    try {
      state = await settings.store.hit(
        `clinical.search|${actor.tenantId}|${actor.userId}`,
        limit.windowMs,
      );
    } catch (error) {
      // Like the other limits: a counter that cannot be reached does not take the feature down.
      request.log.warn(
        { code: (error as { code?: unknown } | null)?.code },
        'rate limit store failed',
      );
      return;
    }
    if (state.count > limit.max) {
      void reply.header('retry-after', String(Math.max(1, Math.ceil(state.resetsInMs / 1000))));
      throw new AppError('rate_limited');
    }
  };
}
