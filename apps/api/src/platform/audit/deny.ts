import type { AuditAction, AuditMetadata } from '@consultorio/contracts';

import type { Db } from '../db/pool.js';
import { createWithTenant } from '../db/tenant-context.js';

import { audit, type AuditActor } from './writer.js';

/** Raised to the platform operator when a denial could not be recorded. Carries no message text. */
export interface AuditAlert {
  kind: 'audit_deny_failed';
  tenantId: string;
  action: AuditAction;
  errorCode: string;
}

export interface AuditDenyEvent {
  action: AuditAction;
  actor: AuditActor;
  resourceType?: string;
  resourceId?: string;
  patientId?: string;
  reason?: string;
  /** Field names, versions, counts. Never clinical content or secrets (validated). */
  metadata?: AuditMetadata;
}

export interface AuditDenyDeps {
  db: Db;
  alert(alert: AuditAlert): void;
}

export type AuditDenyOutcome = { recorded: boolean };

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code;
  const own = (error as { code?: unknown } | null)?.code;
  const value = typeof code === 'string' ? code : own;
  return typeof value === 'string' ? value : 'unknown';
}

/**
 * Builds `auditDeny`, which records a denied attempt on its OWN connection and transaction.
 *
 * A denial usually ends the request with an error, which rolls back the request's transaction;
 * an audit row written in that transaction would vanish with it. This one is committed first, on
 * another pooled connection, so the denial survives (audit-log, "Denied attempt survives rollback").
 *
 * It never throws and never turns a denial into a grant: if the row cannot be written the caller
 * still denies, the function reports `recorded: false` and raises an alert to the platform
 * operator through `alert` (which may itself fail without consequence).
 */
export function createAuditDeny(deps: AuditDenyDeps) {
  const withTenant = createWithTenant(deps.db);

  return async function auditDeny(
    tenantId: string,
    event: AuditDenyEvent,
  ): Promise<AuditDenyOutcome> {
    try {
      await withTenant({ tenantId, userId: event.actor.userId ?? '' }, (tx) =>
        audit(tx, { ...event, outcome: 'deny' }),
      );
      return { recorded: true };
    } catch (error) {
      try {
        deps.alert({
          kind: 'audit_deny_failed',
          tenantId,
          action: event.action,
          errorCode: errorCode(error),
        });
      } catch {
        // A broken alert channel must not change the answer to the caller.
      }
      return { recorded: false };
    }
  };
}
