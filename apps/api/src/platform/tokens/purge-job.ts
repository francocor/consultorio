import { JobPayload } from '../jobs/boss.js';
import { defineJob } from '../jobs/define-job.js';

import { purgeExpiredTokens } from './index.js';

export const TOKEN_PURGE_JOB = 'tokens.purge';

/**
 * The daily job of every organization that deletes the single-purpose links that expired more than a
 * week ago. A housekeeping write: in a read-only organization it waits, because the purge is by
 * age and nothing is lost by waiting.
 */
export function createTokenPurgeJob(deps: { clock?: () => Date } = {}) {
  const clock = deps.clock ?? (() => new Date());
  return defineJob({
    name: TOKEN_PURGE_JOB,
    category: 'write',
    payload: JobPayload,
    handler: async ({ tx }) => {
      await purgeExpiredTokens(tx, { now: clock() });
    },
  });
}
