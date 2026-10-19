import { z } from 'zod';

import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob, type JobDefinition } from '../../../platform/jobs/define-job.js';
import type { PrescriptionDeps } from '../application/common.js';
import { ERX_RECONCILE_JOB, ERX_SUBMIT_JOB } from '../application/job-names.js';
import { reconcileOrganization } from '../application/settle.js';
import { attemptSubmit } from '../application/submit.js';

export { ERX_RECONCILE_JOB, ERX_SUBMIT_JOB };

export const SubmitPayload = JobPayload.extend({ prescriptionId: z.uuid() });
export type SubmitPayload = z.infer<typeof SubmitPayload>;

/** With a prescription: a notice named it. Without: the pass over the whole organization. */
export const ReconcilePayload = JobPayload.extend({ prescriptionId: z.uuid().optional() });
export type ReconcilePayload = z.infer<typeof ReconcilePayload>;

export interface ErxJobs {
  submit: JobDefinition<SubmitPayload>;
  reconcile: JobDefinition<ReconcilePayload>;
  /** Both, to register them (or to run them in a test). */
  definitions: readonly JobDefinition[];
}

/**
 * The two jobs of e-prescription (design 5.5 for the counterpart of invoicing):
 *
 * - `erx.submit`: one attempt to get a pending prescription confirmed. It is queued with the
 *   prescription, in the same transaction, and queues itself again with the wait of the backoff
 *   when the provider cannot answer. Category `write`: in a read-only organization it ends cancelled,
 *   because issuing is refused there.
 * - `erx.reconcile`: asks the provider where the prescriptions of the organization stand (dispensed,
 *   expired, cancelled on its side), tries again the ones that wait and are due, and settles the one
 *   a provider notice named. Category `webhook`: it keeps running in a read-only organization (a
 *   provider notice is allowed there), but it submits nothing there.
 */
export function createErxJobs(deps: PrescriptionDeps): ErxJobs {
  const submit = defineJob({
    name: ERX_SUBMIT_JOB,
    category: 'write',
    payload: SubmitPayload,
    async handler({ tx, payload }) {
      await attemptSubmit(tx, deps, payload.prescriptionId);
    },
  });
  const reconcile = defineJob({
    name: ERX_RECONCILE_JOB,
    category: 'webhook',
    payload: ReconcilePayload,
    async handler({ tx, payload }) {
      await reconcileOrganization(tx, deps, { prescriptionId: payload.prescriptionId });
    },
  });
  return { submit, reconcile, definitions: [submit, reconcile] as readonly JobDefinition[] };
}
