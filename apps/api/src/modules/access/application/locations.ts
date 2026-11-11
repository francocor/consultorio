import type { Role } from '@consultorio/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { membershipLocation } from '../../../db/schema/access.js';
import { location } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { loadMember } from './members.js';

export interface LocationRecord {
  id: string;
  name: string;
  timeZone: string;
  active: boolean;
}

/** Who is looking: owners and admins see every location, everyone else the ones they work at. */
export interface LocationViewer {
  roles: readonly Role[];
  membershipId: string;
}

export function seesEveryLocation(viewer: LocationViewer): boolean {
  return viewer.roles.includes('owner') || viewer.roles.includes('admin');
}

/**
 * The ids of the locations a member may see and operate (authorization, "Membership in
 * locations"), or `'all'` for owners and admins. Reception and professionals get the ones they are
 * assigned to; a member with no assignment gets none. Scheduling, check-in and the cash register
 * filter with this. It never narrows demographics or any clinical rule.
 */
export async function visibleLocationIds(
  tx: Tx,
  viewer: LocationViewer,
): Promise<string[] | 'all'> {
  if (seesEveryLocation(viewer)) return 'all';
  const rows = await tx
    .select({ locationId: membershipLocation.locationId })
    .from(membershipLocation)
    .where(
      and(
        eq(membershipLocation.membershipId, viewer.membershipId),
        isNull(membershipLocation.removedAt),
      ),
    );
  return rows.map((row) => row.locationId);
}

export interface CreateLocationInput {
  actor: AuditActor;
  name: string;
  timeZone: string;
}

export interface UpdateLocationInput {
  actor: AuditActor;
  locationId: string;
  name?: string | undefined;
  timeZone?: string | undefined;
}

export interface SetMemberLocationsInput {
  actor: AuditActor;
  membershipId: string;
  locationIds: readonly string[];
}

export interface LocationService {
  list(
    tx: Tx,
    viewer: LocationViewer,
    options: { includeInactive: boolean },
  ): Promise<LocationRecord[]>;
  create(tx: Tx, input: CreateLocationInput): Promise<LocationRecord>;
  update(tx: Tx, input: UpdateLocationInput): Promise<LocationRecord>;
  setActive(
    tx: Tx,
    input: { actor: AuditActor; locationId: string; active: boolean },
  ): Promise<LocationRecord>;
  memberLocations(tx: Tx, membershipId: string): Promise<string[]>;
  setMemberLocations(tx: Tx, input: SetMemberLocationsInput): Promise<string[]>;
}

const columns = {
  id: location.id,
  name: location.name,
  timeZone: location.timeZone,
  active: location.active,
};

async function findLocation(tx: Tx, locationId: string): Promise<LocationRecord> {
  const [row] = await tx.select(columns).from(location).where(eq(location.id, locationId));
  if (!row) throw new AppError('not_found');
  return row;
}

export function createLocationService(): LocationService {
  const liveAssignments = async (tx: Tx, membershipId: string): Promise<string[]> => {
    const rows = await tx
      .select({ locationId: membershipLocation.locationId })
      .from(membershipLocation)
      .where(
        and(
          eq(membershipLocation.membershipId, membershipId),
          isNull(membershipLocation.removedAt),
        ),
      )
      .orderBy(asc(membershipLocation.createdAt), asc(membershipLocation.id));
    return rows.map((row) => row.locationId);
  };

  return {
    async list(tx, viewer, options) {
      const visible = await visibleLocationIds(tx, viewer);
      if (visible !== 'all' && visible.length === 0) return [];
      const conditions = [
        ...(visible === 'all' ? [] : [inArray(location.id, visible)]),
        ...(options.includeInactive && seesEveryLocation(viewer)
          ? []
          : [eq(location.active, true)]),
      ];
      return tx
        .select(columns)
        .from(location)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(location.name), asc(location.id));
    },

    async create(tx, input) {
      const [row] = await tx
        .insert(location)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          name: input.name,
          timeZone: input.timeZone,
        })
        .returning(columns);
      if (!row) throw new Error('location insert returned no row');
      await audit(tx, {
        action: 'location.created',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'location',
        resourceId: row.id,
      });
      return row;
    },

    async update(tx, input) {
      const current = await findLocation(tx, input.locationId);
      const changes: { name?: string; timeZone?: string } = {};
      if (input.name !== undefined && input.name !== current.name) changes.name = input.name;
      if (input.timeZone !== undefined && input.timeZone !== current.timeZone) {
        changes.timeZone = input.timeZone;
      }
      const fields = Object.keys(changes);
      if (fields.length === 0) return current;

      const [row] = await tx
        .update(location)
        .set(changes)
        .where(eq(location.id, current.id))
        .returning(columns);
      if (!row) throw new AppError('not_found');
      await audit(tx, {
        action: 'location.updated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'location',
        resourceId: row.id,
        // Field names only: the audit trail says what changed, not the values.
        metadata: { fields },
      });
      return row;
    },

    async setActive(tx, input) {
      const current = await findLocation(tx, input.locationId);
      if (current.active === input.active) return current;
      const [row] = await tx
        .update(location)
        .set({ active: input.active })
        .where(eq(location.id, current.id))
        .returning(columns);
      if (!row) throw new AppError('not_found');
      await audit(tx, {
        action: input.active ? 'location.reactivated' : 'location.deactivated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'location',
        resourceId: row.id,
      });
      return row;
    },

    memberLocations: liveAssignments,

    async setMemberLocations(tx, input) {
      const member = await loadMember(tx, input.membershipId);
      if (!member) throw new AppError('not_found');

      const wanted = [...new Set(input.locationIds)];
      const known =
        wanted.length === 0
          ? []
          : await tx
              .select({ id: location.id, active: location.active })
              .from(location)
              .where(inArray(location.id, wanted));
      // A location of another organization does not exist as far as this organization can tell.
      if (known.length !== wanted.length) throw new AppError('not_found');

      const current = await liveAssignments(tx, member.id);
      const added = wanted.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !wanted.includes(id));
      // An inactive location is hidden from new selections; an old assignment to it may stay.
      if (added.some((id) => known.find((place) => place.id === id)?.active === false)) {
        throw new AppError('conflict');
      }

      if (removed.length > 0) {
        await tx
          .update(membershipLocation)
          .set({ removedAt: new Date() })
          .where(
            and(
              eq(membershipLocation.membershipId, member.id),
              inArray(membershipLocation.locationId, removed),
              isNull(membershipLocation.removedAt),
            ),
          );
      }
      if (added.length > 0) {
        await tx.insert(membershipLocation).values(
          added.map((locationId) => ({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            membershipId: member.id,
            locationId,
          })),
        );
      }
      if (added.length > 0 || removed.length > 0) {
        await audit(tx, {
          action: 'location_membership.changed',
          outcome: 'allow',
          actor: input.actor,
          resourceType: 'membership',
          resourceId: member.id,
          metadata: { added, removed },
        });
      }
      return liveAssignments(tx, member.id);
    },
  };
}
