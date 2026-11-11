import {
  AuditMetadata,
  isAuditAction,
  type AuditAction,
  type AuditOutcome,
  type Role,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import { auditEvent } from '../../db/schema/audit.js';
import type { Tx } from '../db/tenant-context.js';

/** Who did it and from where. Filled from the request (see request-context.ts). */
export interface AuditActor {
  /** Null for the system and for callers who are not authenticated. */
  userId: string | null;
  actingRole: Role | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface AuditEventInput {
  action: AuditAction;
  outcome: AuditOutcome;
  actor: AuditActor;
  resourceType?: string;
  resourceId?: string;
  patientId?: string;
  /** Short machine-readable reason, such as `shared` or `admin_has_no_clinical_access`. */
  reason?: string;
  /** Field names, versions, counts. Never clinical content or secrets (validated). */
  metadata?: AuditMetadata;
}

const MAX_USER_AGENT = 512;

/**
 * Writes one audit event inside the caller's transaction (audit-log, "Synchronous, fail-closed
 * writing"). The event commits or rolls back together with the business write it describes, and
 * ANY failure here propagates, so an action that cannot be audited does not happen.
 *
 * The tenant is never a parameter: it is the transaction's own context (`app.tenant_id`), so an
 * event cannot be filed under another tenant. The action must be in the catalogue and the
 * metadata must pass the contracts schema, which rejects clinical content keys and long prose.
 *
 * The row is written unsealed; the sealer job later assigns `seq`, `prev_hash` and `hash`.
 */
export async function audit(tx: Tx, event: AuditEventInput): Promise<void> {
  if (!isAuditAction(event.action)) {
    throw new Error('unknown audit action');
  }
  const metadata = AuditMetadata.parse(event.metadata ?? {});

  await tx.insert(auditEvent).values({
    tenantId: sql`current_setting('app.tenant_id')::uuid`,
    action: event.action,
    outcome: event.outcome,
    actorUserId: event.actor.userId,
    actingRole: event.actor.actingRole,
    ip: event.actor.ip,
    userAgent: event.actor.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
    requestId: event.actor.requestId,
    resourceType: event.resourceType ?? null,
    resourceId: event.resourceId ?? null,
    patientId: event.patientId ?? null,
    reason: event.reason ?? null,
    metadata,
  });
}
