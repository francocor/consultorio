import { and, eq, sql } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

export interface MemberRecord {
  id: string;
  userId: string;
  roles: string[];
  status: 'active' | 'deactivated';
}

/** A member of the transaction's organization. Another organization's member is simply not there. */
export async function loadMember(tx: Tx, membershipId: string): Promise<MemberRecord | null> {
  const [row] = await tx
    .select({
      id: membership.id,
      userId: membership.userId,
      roles: membership.roles,
      status: membership.status,
    })
    .from(membership)
    .where(eq(membership.id, membershipId));
  return row ? { ...row, status: row.status === 'active' ? 'active' : 'deactivated' } : null;
}

/**
 * Locks every active owner of the organization, plus the given members, in a fixed order, and
 * returns them as they are NOW (after any concurrent change committed). Two owners who demote
 * each other at the same moment therefore queue up instead of both seeing "another owner exists":
 * the second one re-reads fresh roles and is refused. The fixed order prevents deadlocks.
 */
export async function lockOwnersAnd(
  tx: Tx,
  memberIds: readonly string[],
): Promise<Map<string, MemberRecord>> {
  const ids = [...new Set(memberIds)];
  const rows = await tx
    .select({
      id: membership.id,
      userId: membership.userId,
      roles: membership.roles,
      status: membership.status,
    })
    .from(membership)
    .where(
      and(
        sql`(${membership.id} in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) or (${membership.status} = 'active' and 'owner' = any(${membership.roles})))`,
      ),
    )
    .orderBy(membership.id)
    .for('update');
  return new Map(
    rows.map((row) => [
      row.id,
      { ...row, status: row.status === 'active' ? ('active' as const) : ('deactivated' as const) },
    ]),
  );
}

/** Active owners other than `exceptMembershipId`, from a locked set. */
export function countOtherActiveOwners(
  locked: ReadonlyMap<string, MemberRecord>,
  exceptMembershipId: string,
): number {
  return [...locked.values()].filter(
    (member) =>
      member.id !== exceptMembershipId &&
      member.status === 'active' &&
      member.roles.includes('owner'),
  ).length;
}
