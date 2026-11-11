import { z } from 'zod';

import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import { attemptIssue, type IssueDeps } from '../application/issue-attempt.js';
import { AFIP_ISSUE_JOB } from '../application/job-names.js';

export { AFIP_ISSUE_JOB };

export const IssuePayload = JobPayload.extend({ invoiceId: z.uuid() });
export type IssuePayload = z.infer<typeof IssuePayload>;

/**
 * `afip.issue` (design 5.5): one attempt to get a pending invoice authorized. It is queued with the
 * invoice, in the same transaction. The category `afip_submission` is the one that still runs in a
 * read-only organization, and only for what was queued before the freeze (the platform decides it
 * from the time the job was enqueued).
 *
 * A job that finds the authority down does not queue itself again: it writes when the next attempt
 * is due (1 minute, doubling, up to 6 hours) and the sweeper of the worker (`runDueAttempts`) takes
 * it from there. A job queued again by a handler would carry the time of the retry, and in a
 * read-only organization the rule "queued before the freeze" would then cancel an invoice that was
 * requested long before it; the sweeper judges each invoice by the time it was requested.
 */
export function createAfipIssueJob(deps: IssueDeps) {
  return defineJob({
    name: AFIP_ISSUE_JOB,
    category: 'afip_submission',
    payload: IssuePayload,
    async handler({ tx, payload }) {
      await attemptIssue(tx, deps, payload.invoiceId);
    },
  });
}
