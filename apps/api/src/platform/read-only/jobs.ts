import { isAllowedWhenReadOnly, type RouteCategory } from '@consultorio/contracts';

import { AppError } from '../http/problem.js';

export interface JobDescriptor {
  /**
   * Same categories as routes. Reminders, offers and other messages are `write`; the audit sealer
   * is `audit_write`; export builds are `export`; AFIP submission is `afip_submission`.
   */
  category: RouteCategory;
}

/**
 * The category of every queue of the application: what a job does when its tenant is read-only.
 * The installer creates a queue only if it is listed in `jobs/queues.ts`, and a test checks that
 * the two lists name the same queues, so a job cannot ship without a decision. Reminders, offers,
 * codes and room creation are `write`: in a read-only tenant they end cancelled and are never
 * replayed after recovery. The audit sealer keeps running (`audit_write`).
 */
export const JOB_CATEGORIES: Readonly<Record<string, RouteCategory>> = {
  'audit.seal': 'audit_write',
  'audit.verify': 'audit_write',
  'hold.expire': 'write',
  'document.scan': 'audit_write',
  'document.cleanup': 'write',
  'reminder.plan': 'write',
  'reminder.send': 'write',
  'reminder.sweep': 'write',
  'otp.send': 'write',
  'booking.purge': 'write',
  'tokens.purge': 'write',
  'waitlist.match': 'write',
  'waitlist.offer': 'write',
  'waitlist.expire': 'write',
  'video.link.create': 'write',
  // Stage 4. AFIP submission keeps running for invoices queued before the freeze (and only those);
  // a PDF and an export are built from records a read-only tenant may read; an invoice email and
  // the certificate warning are messages, so they end cancelled and are never replayed.
  'afip.issue': 'afip_submission',
  'fiscal.credential_watch': 'write',
  'invoice.pdf': 'export',
  'invoice.deliver': 'write',
  'export.build': 'export',
};

/** The category of a queue. A queue nobody classified is refused, not guessed. */
export function jobCategoryOf(queue: string): RouteCategory {
  const category = JOB_CATEGORIES[queue];
  if (category === undefined) throw new Error(`The queue "${queue}" has no read-only category.`);
  return category;
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
