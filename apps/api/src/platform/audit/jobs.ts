import { SYSTEM_USER_ID, type WithTenant } from '../db/tenant-context.js';
import { JobPayload } from '../jobs/boss.js';
import { defineJob, type WorkerLog } from '../jobs/define-job.js';
import type { Metrics } from '../metrics.js';

import { sealTenant } from './sealer.js';
import { verifyTenantChain } from './verify.js';

export const SEAL_JOB = 'audit.seal';
export const VERIFY_JOB = 'audit.verify';

export interface AuditJobDeps {
  /**
   * `withTenant` on the SEALER's connection (`createSealerDb`): sealing runs there, not in the
   * transaction of the job, because only the `audit_sealer` login may fill the seal columns.
   */
  sealer: WithTenant;
  metrics: Metrics;
  log: WorkerLog;
  /** See `SealOptions.graceMs`. */
  graceMs?: number;
}

/**
 * The two audit jobs. Both have the `audit_write` category, which the read-only allowlist keeps
 * running: a read-only or cancelled tenant's trail must still be sealed and checked.
 */
export function createAuditJobs(deps: AuditJobDeps) {
  const seal = defineJob({
    name: SEAL_JOB,
    category: 'audit_write',
    payload: JobPayload,
    handler: async ({ tenantId }) => {
      // Sealing only touches unsealed rows, so a redelivery after a failure in the job's own
      // transaction repeats it harmlessly.
      await deps.sealer({ tenantId, userId: SYSTEM_USER_ID }, (sealerTx) =>
        sealTenant(sealerTx, {
          metrics: deps.metrics,
          ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
        }),
      );
    },
  });

  const verify = defineJob({
    name: VERIFY_JOB,
    category: 'audit_write',
    payload: JobPayload,
    handler: async ({ tx, tenantId }) => {
      const result = await verifyTenantChain(tx);
      const labels = { tenant: tenantId };
      deps.metrics.gauge('audit_chain_verified_events', result.verified, labels);
      if (!result.ok) {
        deps.metrics.increment('audit_chain_break_total', labels);
        deps.log.error(
          { tenant: tenantId, firstBadSeq: result.firstBadSeq, reason: result.reason },
          'audit chain break',
        );
      }
    },
  });

  return { seal, verify };
}
