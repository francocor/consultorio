/** The queues of the prescriptions module (declared in `platform/jobs/queues.ts` by the seam). */

/** Submits (or retries) one prescription the provider has not confirmed. */
export const ERX_SUBMIT_JOB = 'erx.submit';
/** Asks the provider where the prescriptions of an organization stand, or of one prescription. */
export const ERX_RECONCILE_JOB = 'erx.reconcile';
