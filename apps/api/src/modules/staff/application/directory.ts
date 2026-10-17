import type { StaffMemberDto, StaffRole } from '@consultorio/contracts';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { membershipLocation } from '../../../db/schema/access.js';
import { membership, userAccount } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';

import { managesStaff } from './profile.js';

export interface Viewer {
  membershipId: string;
  roles: readonly string[];
}

export interface DirectoryService {
  list(tx: Tx, viewer: Viewer, options: { includeDeactivated: boolean }): Promise<StaffMemberDto[]>;
  find(tx: Tx, viewer: Viewer, membershipId: string): Promise<StaffMemberDto>;
  rename(
    tx: Tx,
    input: {
      actor: AuditActor & { userId: string };
      viewer: Viewer;
      targetMembershipId: string;
      displayName: string;
    },
  ): Promise<void>;
}

function asStaffRoles(roles: string[]): StaffRole[] {
  return roles.filter(
    (role): role is StaffRole =>
      role === 'owner' || role === 'admin' || role === 'professional' || role === 'reception',
  );
}

export function createDirectoryService(): DirectoryService {
  /** Every member the viewer may see, with the private fields shown only where they may be. */
  async function load(
    tx: Tx,
    viewer: Viewer,
    options: { includeDeactivated: boolean; only?: string },
  ) {
    const manager = managesStaff(viewer.roles);
    const members = await tx
      .select({
        id: membership.id,
        displayName: membership.displayName,
        roles: membership.roles,
        status: membership.status,
        email: userAccount.email,
      })
      .from(membership)
      .innerJoin(userAccount, eq(userAccount.id, membership.userId))
      .where(
        and(
          options.only === undefined ? undefined : eq(membership.id, options.only),
          options.includeDeactivated && manager ? undefined : eq(membership.status, 'active'),
        ),
      )
      .orderBy(asc(membership.createdAt), asc(membership.id));
    if (members.length === 0) return [];

    const ids = members.map((member) => member.id);
    const profiles = await tx
      .select()
      .from(professional)
      .where(inArray(professional.membershipId, ids));
    const assignments = await tx
      .select({
        membershipId: membershipLocation.membershipId,
        id: location.id,
        name: location.name,
      })
      .from(membershipLocation)
      .innerJoin(location, eq(location.id, membershipLocation.locationId))
      .where(
        and(inArray(membershipLocation.membershipId, ids), isNull(membershipLocation.removedAt)),
      )
      .orderBy(asc(location.name));

    const rows = members.map((member): StaffMemberDto => {
      const privateView = manager || member.id === viewer.membershipId;
      const profile = profiles.find((candidate) => candidate.membershipId === member.id);
      return {
        membershipId: member.id,
        displayName: member.displayName,
        roles: asStaffRoles(member.roles),
        status: member.status === 'active' ? 'active' : 'deactivated',
        email: privateView ? member.email : null,
        locations: assignments
          .filter((assignment) => assignment.membershipId === member.id)
          .map(({ id, name }) => ({ id, name })),
        professional: profile
          ? {
              id: profile.id,
              status: profile.status === 'active' ? 'active' : 'inactive',
              specialties: profile.specialties,
              matricula:
                privateView && profile.matricula !== null && profile.matriculaJurisdiction !== null
                  ? {
                      jurisdiction: profile.matriculaJurisdiction,
                      number: profile.matricula,
                      status: profile.matriculaStatus === 'verified' ? 'verified' : 'unverified',
                    }
                  : null,
            }
          : null,
      };
    });
    return rows.sort((left, right) =>
      (left.displayName ?? left.email ?? '~').localeCompare(
        right.displayName ?? right.email ?? '~',
        'es',
      ),
    );
  }

  return {
    list: (tx, viewer, options) => load(tx, viewer, options),

    async find(tx, viewer, membershipId) {
      const [row] = await load(tx, viewer, { includeDeactivated: true, only: membershipId });
      if (!row) throw new AppError('not_found');
      return row;
    },

    async rename(tx, input) {
      const target = input.targetMembershipId;
      if (target !== input.viewer.membershipId && !managesStaff(input.viewer.roles)) {
        throw new AccessRefused('profile_not_self');
      }
      const updated = await tx
        .update(membership)
        .set({ displayName: input.displayName })
        .where(eq(membership.id, target))
        .returning({ id: membership.id });
      if (updated.length === 0) throw new AppError('not_found');
      await audit(tx, {
        action: 'staff.profile_updated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'membership',
        resourceId: target,
        metadata: { fields: ['fullName'] },
      });
    },
  };
}
