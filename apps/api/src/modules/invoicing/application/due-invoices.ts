import { and, asc, eq, lte } from 'drizzle-orm';

import { invoice } from '../../../db/schema/index.js';
import { tenant } from '../../../db/schema/tenant.js';
import type { Db } from '../../../platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant } from '../../../platform/db/tenant-context.js';
import { listTenantIds } from '../../../platform/jobs/tenant-scan.js';
import { jobMayRun } from '../../../platform/read-only/jobs.js';

import { attemptIssue, type AttemptOutcome, type IssueDeps } from './issue-attempt.js';

/** How many invoices of one organization are tried in one pass. */
const BATCH = 20;

export interface DueLog {
  error(object: Record<string, unknown>, message: string): void;
}

/**
 * Tries again the pending invoices whose next attempt is due (design 5.5: "backs off from 1 minute
 * to 6 hours"). This is the clock of the retries. An attempt that finds the authority down only
 * writes when the next one is due; this pass reads that and calls the same `attemptIssue`.
 *
 * Read-only organizations (tenancy, "Read-only tenant and its allowlist"): an invoice requested
 * BEFORE the freeze is still submitted; one requested after it never is. The invoice is judged by the
 * time it was requested, the same rule the platform applies to a queued job, so a long outage that
 * spans the freeze does not lose a fiscal obligation that was already recorded.
 *
 * Returns what each attempt ended in. A failure of one invoice is logged and does not stop the rest.
 */
export async function runDueAttempts(
  db: Db,
  deps: IssueDeps,
  log: DueLog = { error: () => undefined },
): Promise<{ invoiceId: string; outcome: AttemptOutcome }[]> {
  const withTenant = createWithTenant(db);
  const results: { invoiceId: string; outcome: AttemptOutcome }[] = [];
  const now = deps.clock();

  for (const tenantId of await listTenantIds(db)) {
    const due = await withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
      const [state] = await tx
        .select({ status: tenant.status, readOnlySince: tenant.readOnlySince })
        .from(tenant)
        .where(eq(tenant.id, tenantId));
      if (!state) return [];
      const rows = await tx
        .select({ id: invoice.id, createdAt: invoice.createdAt })
        .from(invoice)
        .where(and(eq(invoice.status, 'pending'), lte(invoice.nextAttemptAt, now)))
        .orderBy(asc(invoice.nextAttemptAt), asc(invoice.id))
        .limit(BATCH);
      return rows.filter(
        (row) =>
          jobMayRun(
            { category: 'afip_submission' },
            {
              status:
                state.status === 'read_only' || state.status === 'cancelled'
                  ? state.status
                  : 'active',
              readOnlySince: state.readOnlySince,
            },
            row.createdAt,
          ).run,
      );
    });

    for (const row of due) {
      try {
        const outcome = await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
          attemptIssue(tx, deps, row.id),
        );
        results.push({ invoiceId: row.id, outcome });
      } catch (error) {
        const code = (error as { cause?: { code?: string } } | null)?.cause?.code ?? 'unknown';
        log.error({ invoiceId: row.id, code }, 'the attempt to issue an invoice failed');
      }
    }
  }
  return results;
}
