import { sql } from 'drizzle-orm';

import type { CanonicalAuditRow } from './canonicalize.js';

/**
 * The columns of an audit row in the exact text form the hash is computed over. The sealer and the
 * verifier both select through this fragment, so they can never disagree about how a timestamp or
 * an address is written. Timestamps are UTC with microseconds (JavaScript dates would drop them).
 */
export const CANONICAL_COLUMNS = sql.raw(`
  id::text AS "id",
  tenant_id::text AS "tenantId",
  seq::text AS "seqNo",
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
  occurred_at::text AS "occurredAtRaw",
  actor_user_id::text AS "actorUserId",
  acting_role AS "actingRole",
  action,
  resource_type AS "resourceType",
  resource_id::text AS "resourceId",
  patient_id::text AS "patientId",
  outcome,
  reason,
  host(ip) AS "ip",
  user_agent AS "userAgent",
  request_id AS "requestId",
  metadata,
  prev_hash AS "prevHash",
  hash`);

/** One row as selected with `CANONICAL_COLUMNS`. */
export type RawChainRow = {
  id: string;
  tenantId: string;
  /** Sequence number as text (bigint), null while unsealed. Named so ORDER BY seq stays the column. */
  seqNo: string | null;
  occurredAt: string;
  /** The original timestamp text, for addressing the row in an UPDATE without losing precision. */
  occurredAtRaw: string;
  actorUserId: string | null;
  actingRole: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  patientId: string | null;
  outcome: string;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: unknown;
  prevHash: string | null;
  hash: string | null;
};

/** The hashed content of a row, with the sequence number it has (or is about to get). */
export function toCanonical(row: RawChainRow, seq: number): CanonicalAuditRow {
  return {
    id: row.id,
    tenantId: row.tenantId,
    seq,
    occurredAt: row.occurredAt,
    actorUserId: row.actorUserId,
    actingRole: row.actingRole,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    patientId: row.patientId,
    outcome: row.outcome,
    reason: row.reason,
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId,
    metadata: row.metadata,
  };
}
