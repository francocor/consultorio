import {
  AuditMetadata,
  isPlatformAuditAction,
  type AuditOutcome,
  type PlatformAuditAction,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import { platformAuditEvent } from '../../db/schema/operator.js';
import type { Tx } from '../db/tenant-context.js';

import { GENESIS_HASH, hashEvent } from './canonicalize.js';
import { toCanonical, type RawChainRow } from './chain.js';
import type { ChainBreakReason, VerifyResult } from './verify.js';

/**
 * The trail of the platform itself (operator sign-ins, tenant creation, support access). It is one
 * global chain with the same rules as a tenant's: written inside the transaction of the action it
 * describes, append-only, and sealed afterwards with `hash = SHA-256(prev_hash || canonical row)`.
 * The canonical form is the tenant one: the operator is the actor and the target organization
 * takes the place of the tenant.
 */

export interface PlatformAuditActor {
  operatorId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface PlatformAuditInput {
  action: PlatformAuditAction;
  outcome: AuditOutcome;
  actor: PlatformAuditActor;
  /** The organization the action is about, when there is one. */
  targetTenantId?: string;
  reason?: string;
  resourceType?: string;
  resourceId?: string;
  /** Flat scalars, validated like tenant audit metadata (no secrets, no content). */
  metadata?: AuditMetadata;
}

const MAX_USER_AGENT = 512;

/** Writes one platform event in the caller's transaction; any failure fails the action. */
export async function writePlatformAudit(tx: Tx, event: PlatformAuditInput): Promise<void> {
  if (!isPlatformAuditAction(event.action)) {
    throw new Error('unknown platform audit action');
  }
  const metadata = AuditMetadata.parse(event.metadata ?? {});
  await tx.insert(platformAuditEvent).values({
    operatorId: event.actor.operatorId,
    targetTenantId: event.targetTenantId ?? null,
    action: event.action,
    outcome: event.outcome,
    reason: event.reason ?? null,
    resourceType: event.resourceType ?? null,
    resourceId: event.resourceId ?? null,
    ip: event.actor.ip,
    userAgent: event.actor.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
    requestId: event.actor.requestId,
    metadata,
  });
}

/** The columns in the exact text form the hash is computed over (same shape as the tenant chain). */
const PLATFORM_COLUMNS = sql.raw(`
  id::text AS "id",
  coalesce(target_tenant_id::text, '') AS "tenantId",
  seq::text AS "seqNo",
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
  occurred_at::text AS "occurredAtRaw",
  operator_id::text AS "actorUserId",
  'operator'::text AS "actingRole",
  action,
  resource_type AS "resourceType",
  resource_id::text AS "resourceId",
  NULL::text AS "patientId",
  outcome,
  reason,
  host(ip) AS "ip",
  user_agent AS "userAgent",
  request_id AS "requestId",
  metadata,
  prev_hash AS "prevHash",
  hash`);

export interface PlatformSealOptions {
  graceMs?: number;
  batchSize?: number;
}

const DEFAULT_GRACE_MS = 2000;
const DEFAULT_BATCH = 500;

/**
 * Seals the pending platform events, in `(occurred_at, id)` order. Runs on the sealer's own connection
 * (`createSealerDb`, the `audit_sealer` login only the worker holds), the only role the append-only
 * trigger lets fill the seal columns, and takes an advisory lock so two
 * sealers cannot number the same events.
 */
export async function sealPlatformAudit(
  tx: Tx,
  options: PlatformSealOptions = {},
): Promise<{ sealed: number; lastSeq: number }> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const batch = options.batchSize ?? DEFAULT_BATCH;

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('audit.seal.platform', 0))`);

  const last = await tx.execute<{ lastSeq: string; hash: string }>(
    sql`SELECT seq::text AS "lastSeq", hash
          FROM platform_audit_event
         WHERE seq IS NOT NULL
         ORDER BY seq DESC
         LIMIT 1`,
  );
  let seq = Number(last.rows[0]?.lastSeq ?? 0);
  let previous = last.rows[0]?.hash ?? GENESIS_HASH;

  const pending = await tx.execute<RawChainRow>(
    sql`SELECT ${PLATFORM_COLUMNS}
          FROM platform_audit_event
         WHERE seq IS NULL
           AND occurred_at <= clock_timestamp() - make_interval(secs => ${graceMs / 1000})
         ORDER BY occurred_at, id
         LIMIT ${batch}`,
  );

  for (const row of pending.rows) {
    seq += 1;
    const hash = hashEvent(previous, toCanonical(row, seq));
    await tx.execute(
      sql`UPDATE platform_audit_event
             SET seq = ${seq}, prev_hash = ${previous}, hash = ${hash}
           WHERE id = ${row.id}::uuid AND seq IS NULL`,
    );
    previous = hash;
  }
  return { sealed: pending.rows.length, lastSeq: seq };
}

/** Re-walks the platform chain from sequence 1 and reports the first place it breaks. */
export async function verifyPlatformChain(
  tx: Tx,
  options: { pageSize?: number } = {},
): Promise<VerifyResult> {
  const pageSize = options.pageSize ?? 1000;
  let expectedSeq = 1;
  let previous = GENESIS_HASH;
  let verified = 0;

  for (;;) {
    const page = await tx.execute<RawChainRow>(
      sql`SELECT ${PLATFORM_COLUMNS}
            FROM platform_audit_event
           WHERE seq IS NOT NULL AND seq >= ${expectedSeq}
           ORDER BY seq
           LIMIT ${pageSize}`,
    );
    if (page.rows.length === 0) return { ok: true, verified };

    for (const row of page.rows) {
      const seq = Number(row.seqNo);
      const broken = (reason: ChainBreakReason, at: number): VerifyResult => ({
        ok: false,
        firstBadSeq: at,
        reason,
        verified,
      });
      if (seq !== expectedSeq) return broken('gap', expectedSeq);
      if (row.prevHash !== previous) return broken('prev_hash_mismatch', seq);
      const recomputed = hashEvent(previous, toCanonical(row, seq));
      if (row.hash !== recomputed) return broken('hash_mismatch', seq);
      previous = recomputed;
      expectedSeq = seq + 1;
      verified += 1;
    }
  }
}
