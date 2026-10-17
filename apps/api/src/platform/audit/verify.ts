import { sql } from 'drizzle-orm';

import type { Tx } from '../db/tenant-context.js';

import { GENESIS_HASH, hashEvent } from './canonicalize.js';
import { CANONICAL_COLUMNS, toCanonical, type RawChainRow } from './chain.js';

export type ChainBreakReason = 'gap' | 'prev_hash_mismatch' | 'hash_mismatch';

export type VerifyResult =
  | { ok: true; verified: number }
  | { ok: false; firstBadSeq: number; reason: ChainBreakReason; verified: number };

const DEFAULT_PAGE = 1000;

/**
 * Re-walks a tenant's sealed chain from sequence 1 and reports the FIRST place where it breaks:
 * - `gap`: the next sequence number is missing (a row was removed, or the start is gone);
 * - `prev_hash_mismatch`: the row does not point at the hash of its predecessor (reordering);
 * - `hash_mismatch`: the stored hash differs from the one recomputed from the row (alteration).
 *
 * Unsealed events are not part of the chain yet and are ignored. Removing the newest sealed rows
 * leaves a shorter but internally consistent chain; the seal-lag and chain-length metrics, and
 * the periodic external anchor planned for Stage 6, are what cover that case.
 */
export async function verifyTenantChain(
  tx: Tx,
  options: { pageSize?: number } = {},
): Promise<VerifyResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE;
  let expectedSeq = 1;
  let previous = GENESIS_HASH;
  let verified = 0;

  for (;;) {
    const page = await tx.execute<RawChainRow>(
      sql`SELECT ${CANONICAL_COLUMNS}
            FROM audit_event
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND seq IS NOT NULL AND seq >= ${expectedSeq}
           ORDER BY audit_event.seq
           LIMIT ${pageSize}`,
    );
    if (page.rows.length === 0) return { ok: true, verified };

    for (const row of page.rows) {
      const seq = Number(row.seqNo);
      if (seq !== expectedSeq) {
        return { ok: false, firstBadSeq: expectedSeq, reason: 'gap', verified };
      }
      if (row.prevHash !== previous) {
        return { ok: false, firstBadSeq: seq, reason: 'prev_hash_mismatch', verified };
      }
      const recomputed = hashEvent(previous, toCanonical(row, seq));
      if (row.hash !== recomputed) {
        return { ok: false, firstBadSeq: seq, reason: 'hash_mismatch', verified };
      }
      previous = recomputed;
      expectedSeq = seq + 1;
      verified += 1;
    }
  }
}
