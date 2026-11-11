import { sql } from 'drizzle-orm';

import type { Tx } from './tenant-context.js';

/**
 * Makes two branches of a public flow cost the server the same number of round trips. A visitor
 * who types a document number must not be able to tell, from the way the answer comes, whether the
 * number belongs to a patient (online-booking, "Booking completion and patient identification"):
 * the branch that registers a new person writes several rows the other branch does not, so the
 * shorter branch sends this many cheap reads to Postgres instead.
 *
 * This evens out the shape of the work (what a spy on the driver counts), not its exact duration.
 * The rate limits and the one-time code are what stop a visitor from asking often enough to measure
 * the rest. The counts that callers pass are pinned by `test/security/public-nondisclosure.test.ts`,
 * so changing what a branch writes fails that test until the number is adjusted.
 */
export async function evenOut(tx: Tx, statements: number): Promise<void> {
  for (let sent = 0; sent < statements; sent += 1) await tx.execute(sql`select 1`);
}
