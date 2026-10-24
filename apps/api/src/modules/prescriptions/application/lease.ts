import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { prescription, type PrescriptionRow } from '../../../db/schema/prescriptions.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * How long an attempt that holds no connection owns the row. Longer than the longest wait for the
 * provider (a call, the question before it, and the writes around them), shorter than the wait of a
 * person; a crashed attempt leaves a lease that simply runs out.
 */
export const LEASE_MS = 120_000;

type LeaseFields = Pick<
  PrescriptionRow,
  'attemptLeaseUntil' | 'attemptLeaseToken' | 'providerInFlightUntil'
>;

/** Another attempt is waiting for the provider without a connection: it owns the row. */
export function leaseIsLive(row: Pick<LeaseFields, 'attemptLeaseUntil'>, now: Date): boolean {
  return row.attemptLeaseUntil !== null && row.attemptLeaseUntil.getTime() > now.getTime();
}

/**
 * A call to the provider timed out and may still be running there (JD-S5 R2-3): nothing is sent
 * again, cancelled or registered by hand until the pin ends.
 */
export function pinnedInFlight(
  row: Pick<LeaseFields, 'providerInFlightUntil'>,
  now: Date,
): boolean {
  return row.providerInFlightUntil !== null && row.providerInFlightUntil.getTime() > now.getTime();
}

/**
 * Takes the lease of a row for an attempt that will wait for the provider without a transaction: the
 * row is owned until `LEASE_MS` from now, and the token says by whom. A lease that ran out is taken
 * over. It returns the token, which is the only thing that can release the lease.
 */
export async function takeLease(tx: Tx, prescriptionId: string, now: Date): Promise<string> {
  const token = randomUUID();
  await tx
    .update(prescription)
    .set({ attemptLeaseUntil: new Date(now.getTime() + LEASE_MS), attemptLeaseToken: token })
    .where(eq(prescription.id, prescriptionId));
  return token;
}

/**
 * Lets go of a lease, but only if it is still the one of this token (JD-S5 R2-7): an attempt that
 * overran, whose lease another attempt took over, must not end the lease of the other one.
 */
export async function releaseLease(
  tx: Tx,
  prescriptionId: string,
  token: string,
): Promise<boolean> {
  const released = await tx
    .update(prescription)
    .set({ attemptLeaseUntil: null, attemptLeaseToken: null })
    .where(and(eq(prescription.id, prescriptionId), eq(prescription.attemptLeaseToken, token)))
    .returning({ id: prescription.id });
  return released.length > 0;
}
