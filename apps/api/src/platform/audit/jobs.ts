import { JobPayload } from '../jobs/boss.js';
import { defineJob, type WorkerLog } from '../jobs/define-job.js';
import type { Metrics } from '../metrics.js';

import { sealTenant } from './sealer.js';
import { verifyTenantChain } from './verify.js';

export const SEAL_JOB = 'audit.seal';
export const VERIFY_JOB = 'audit.verify';

export interface AuditJobDeps {
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
    handler: async ({ tx }) => {
      await sealTenant(tx, {
        metrics: deps.metrics,
        ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
      });
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
