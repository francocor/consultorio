import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * What the patient has paid of each charge, net of refunds, in cents. Payments arrive with the
 * next slice (S4.03); until the table exists nothing has been paid.
 */
export function paidNetByCharge(
  _tx: Tx,
  chargeIds: readonly string[],
): Promise<Map<string, number>> {
  return Promise.resolve(new Map(chargeIds.map((id) => [id, 0])));
}
