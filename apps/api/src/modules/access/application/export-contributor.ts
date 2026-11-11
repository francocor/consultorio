import { asc, eq } from 'drizzle-orm';

import { membershipLocation, permissionGrant } from '../../../db/schema/access.js';
import { membership, userAccount } from '../../../db/schema/identity.js';
import { location } from '../../../db/schema/tenant.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by access: who was granted which permission (with the revoked
 * ones, since the history is part of the record), where each member works, and the locations.
 */
export const exportAccess: ExportContributor = async ({ tx }) => {
  const grants = await tx
    .select({
      member: userAccount.email,
      permission: permissionGrant.permission,
      scope: permissionGrant.scope,
      grantedAt: permissionGrant.createdAt,
      revokedAt: permissionGrant.revokedAt,
    })
    .from(permissionGrant)
    .innerJoin(membership, eq(membership.id, permissionGrant.membershipId))
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .orderBy(asc(permissionGrant.createdAt));

  const assignments = await tx
    .select({
      member: userAccount.email,
      location: location.name,
      since: membershipLocation.createdAt,
      removedAt: membershipLocation.removedAt,
    })
    .from(membershipLocation)
    .innerJoin(membership, eq(membership.id, membershipLocation.membershipId))
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .innerJoin(location, eq(location.id, membershipLocation.locationId))
    .orderBy(asc(membershipLocation.createdAt));

  const locations = await tx
    .select({ name: location.name, timeZone: location.timeZone, active: location.active })
    .from(location)
    .orderBy(asc(location.name));

  return { grants, locationAssignments: assignments, locations };
};
