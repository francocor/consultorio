/**
 * Who holds whom inside one series of invoices (organization, point of sale and voucher type).
 *
 * The number an invoice is expected to get is the one after the highest we hold. If the request of
 * an invoice may have been answered (`awaiting_reconciliation`), the voucher it was given is out there
 * under a number the other invoices of the series would be expecting too: nothing of the series is
 * sent until that one is settled. Among invoices that all wait, the oldest goes first (the ids are
 * time ordered UUIDs). Pure: no clock, no database.
 */

export interface SeriesMember {
  id: string;
  /** Whether the request to the authority may have been answered. */
  awaiting: boolean;
}

/**
 * The invoice that holds `member` back, or undefined when nothing does: the oldest invoice of the
 * series that waits for reconciliation, unless that is the member itself. `members` are the pending
 * invoices of the series that no person is looking at.
 */
export function blockerOf(
  member: SeriesMember,
  members: readonly SeriesMember[],
): SeriesMember | undefined {
  let oldest: SeriesMember | undefined;
  for (const other of members) {
    if (!other.awaiting) continue;
    if (oldest === undefined || other.id < oldest.id) oldest = other;
  }
  return oldest !== undefined && oldest.id !== member.id ? oldest : undefined;
}

/** How many of the members the given blocker holds back. */
export function heldCount(blockerId: string, members: readonly SeriesMember[]): number {
  return members.filter((member) => blockerOf(member, members)?.id === blockerId).length;
}
