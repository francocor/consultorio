import { createHash } from 'node:crypto';

/** The `prev_hash` of the first event of a tenant's chain. */
export const GENESIS_HASH = '0'.repeat(64);

/** Format version, the first element of every canonical row. Bump it if the layout ever changes. */
const FORMAT = 'v1';

/**
 * The immutable content of an audit row, with every value already in its canonical text form:
 * timestamps as UTC ISO strings with microseconds, `ip` as host text, metadata as parsed JSON.
 * Building it from the database is the job of `loadCanonicalRows`; this module only serializes.
 */
export interface CanonicalAuditRow {
  id: string;
  tenantId: string;
  seq: number;
  occurredAt: string;
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
}

/** JSON with object keys sorted at every depth, so equal data always serializes identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * One row as an unambiguous string: a fixed-order JSON array, so a null is never confused with an
 * empty string and no field can bleed into its neighbour. `seq` is included, so moving a row
 * to another position changes its hash.
 */
export function canonicalize(row: CanonicalAuditRow): string {
  return JSON.stringify([
    FORMAT,
    row.id,
    row.tenantId,
    row.seq,
    row.occurredAt,
    row.actorUserId,
    row.actingRole,
    row.action,
    row.resourceType,
    row.resourceId,
    row.patientId,
    row.outcome,
    row.reason,
    row.ip,
    row.userAgent,
    row.requestId,
    stableStringify(row.metadata),
  ]);
}

/** `hash = SHA-256(prev_hash || canonical row)`, as lowercase hex. */
export function hashEvent(prevHash: string, row: CanonicalAuditRow): string {
  return createHash('sha256')
    .update(`${prevHash}\n${canonicalize(row)}`)
    .digest('hex');
}
