import { and, eq, lte } from 'drizzle-orm';

import { consentRequest } from '../../../db/schema/consent.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';

export const CONSENT_EXPIRE_JOB = 'consent.expire';

const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

/** Requests closed by one run. A larger backlog is finished by the next run. */
const BATCH = 500;

/**
 * Closes the requests whose time ran out (informed-consent, "Request expires"). The read model
 * and the signing service already treat a pending request past its date as expired, so nobody can
 * sign it in the meantime; this job makes the state and the audit entry (`consent.expired`) real.
 * Idempotent: it only touches pending requests that are past their date, and skips a row another
 * transaction holds. It is a write, so a read-only organization has no request to expire anyway.
 */
export function createConsentExpireJob(deps: { clock: () => Date }) {
  return defineJob({
    name: CONSENT_EXPIRE_JOB,
    category: 'write',
    payload: JobPayload,
    async handler({ tx }) {
      const now = deps.clock();
      const due = await tx
        .select({ id: consentRequest.id, patientId: consentRequest.patientId })
        .from(consentRequest)
        .where(and(eq(consentRequest.status, 'pending'), lte(consentRequest.expiresAt, now)))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      for (const request of due) {
        await tx
          .update(consentRequest)
          .set({ status: 'expired', closedAt: now })
          .where(eq(consentRequest.id, request.id));
        await audit(tx, {
          action: 'consent.expired',
          outcome: 'allow',
          actor: SYSTEM_ACTOR,
          resourceType: 'consent_request',
          resourceId: request.id,
          patientId: request.patientId,
          metadata: { via: 'job' },
        });
      }
    },
  });
}
