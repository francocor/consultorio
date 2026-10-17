import { isAllowedWhenReadOnly, type RouteCategory } from '@consultorio/contracts';

import { AppError } from '../http/problem.js';

export interface JobDescriptor {
  /**
   * Same categories as routes. Reminders, offers and other messages are `write`; the audit sealer
   * is `audit_write`; export builds are `export`; AFIP submission is `afip_submission`.
   */
  category: RouteCategory;
}

export interface TenantState {
  status: 'active' | 'read_only' | 'cancelled';
  readOnlySince: Date | null;
}

export type JobDecision = { run: true } | { run: false; reason: 'tenant_read_only' };

/**
 * Decides, at run time, whether a job may execute for a tenant. Jobs re-check the tenant every time
 * they run (never at enqueue time only):
 * - an active tenant runs everything;
 * - a read-only (or cancelled) tenant runs only allowlisted categories, so messages scheduled
 *   during the read-only period are cancelled with the reason "tenant_read_only" and are never
 *   replayed after recovery;
 * - an AFIP submission additionally needs to have been queued BEFORE `read_only_since`.
 */
export function jobMayRun(job: JobDescriptor, tenant: TenantState, enqueuedAt: Date): JobDecision {
  if (tenant.status === 'active') return { run: true };
  if (!isAllowedWhenReadOnly(job.category)) return { run: false, reason: 'tenant_read_only' };
  if (job.category === 'afip_submission') {
    const queuedBeforeFreeze =
      tenant.readOnlySince !== null && enqueuedAt.getTime() < tenant.readOnlySince.getTime();
    if (!queuedBeforeFreeze) return { run: false, reason: 'tenant_read_only' };
  }
  return { run: true };
}

/** Throws `tenant_read_only` when `jobMayRun` says no. Job wrappers turn it into a cancelled job. */
export function assertTenantWritable(
  job: JobDescriptor,
  tenant: TenantState,
  enqueuedAt: Date,
): void {
  const decision = jobMayRun(job, tenant, enqueuedAt);
  if (!decision.run) throw new AppError('tenant_read_only');
}
