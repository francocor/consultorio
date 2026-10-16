import { asc, eq } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by identity: the staff of the organization, their roles and
 * their status. Credentials never leave the database: no password hash, no second-factor secret,
 * no recovery code. The transaction is bound to the exporting tenant, so a user of another
 * organization cannot appear even if a filter were forgotten.
 */
export const exportStaff: ExportContributor = async ({ tx }) => {
  const staff = await tx
    .select({
      email: userAccount.email,
      roles: membership.roles,
      status: membership.status,
      joinedAt: membership.createdAt,
    })
    .from(membership)
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .orderBy(asc(userAccount.email));
  return { staff };
};
