import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';

import { suspendMajorityLinks } from './dependents.js';

export const MAJORITY_REVIEW_JOB = 'portal.majority_review';

/**
 * The daily review of the organization: the representative links of the dependents who turned 18 are
 * suspended until the adult authorizes them. The queue is `patient_protective`: it runs in a
 * read-only organization too, because what it protects is the privacy of a person who is no longer a
 * child.
 */
export function createMajorityReviewJob(deps: { clock?: () => Date } = {}) {
  const clock = deps.clock ?? (() => new Date());
  return defineJob({
    name: MAJORITY_REVIEW_JOB,
    category: 'patient_protective',
    payload: JobPayload,
    handler: async ({ tx }) => {
      await suspendMajorityLinks(tx, { now: clock() });
    },
  });
}
