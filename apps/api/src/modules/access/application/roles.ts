import type { StaffRole } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { evaluateRoleChange } from '../domain/role-change.js';

import { countOtherActiveOwners, lockOwnersAnd } from './members.js';
import {
  prepareProfessionalAddedNotice,
  type ProfessionalAddedNotice,
} from './professional-notice.js';
import { AccessRefused } from './refusal.js';

/** What the role change needs from the session service (ends the sessions of the changed member). */
export interface SessionRevoker {
  revokeAllForUser(
    tx: Tx,
    userId: string,
    reason: 'privilege_changed' | 'deactivated',
  ): Promise<number>;
}

export interface ChangeRolesInput {
  actor: AuditActor & { userId: string };
  actorMembershipId: string;
  targetMembershipId: string;
  newRoles: readonly StaffRole[];
}

export interface RoleService {
  /**
   * `notice` is set when an admin who is not an owner added the professional role (decision D19):
   * the caller emails the owners once the transaction has committed.
   */
  changeRoles(
    tx: Tx,
    input: ChangeRolesInput,
  ): Promise<{ roles: StaffRole[]; notice: ProfessionalAddedNotice | null }>;
}

async function memberName(tx: Tx, membershipId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ name: membership.displayName })
    .from(membership)
    .where(eq(membership.id, membershipId));
  return row?.name ?? undefined;
}

/**
 * The limit of professionals of the plan, asked by whoever composes the application (the subscriptions
 * module owns it; access does not depend on it). Absent: no limit is asked, as in a test of roles alone.
 */
export interface SeatLimit {
  assertAvailable(tx: Tx): Promise<void>;
}

export function createRoleService(deps: {
  sessions: SessionRevoker;
  seats?: SeatLimit;
}): RoleService {
  return {
    async changeRoles(tx, input) {
      // Everything below reads the roles as they are now, after any concurrent change: the roles of
      // the session are only as fresh as the request, and two owners may be demoting each other.
      const locked = await lockOwnersAnd(tx, [input.actorMembershipId, input.targetMembershipId]);
      const actor = locked.get(input.actorMembershipId);
      const target = locked.get(input.targetMembershipId);
      if (!target) throw new AppError('not_found');
      if (actor?.status !== 'active') throw new AccessRefused('role_change_actor_inactive');

      const verdict = evaluateRoleChange({
        actor: { membershipId: actor.id, roles: actor.roles as StaffRole[] },
        target: {
          membershipId: target.id,
          roles: target.roles as StaffRole[],
          status: target.status,
        },
        newRoles: input.newRoles,
        otherActiveOwners: countOtherActiveOwners(locked, target.id),
      });
      if (!verdict.ok) {
        if (verdict.reason === 'inactive_target') throw new AppError('conflict');
        if (verdict.reason === 'invalid_roles') throw new AppError('validation_failed');
        throw new AccessRefused(`role_change_${verdict.reason}`);
      }

      // Giving the professional role back to a member whose profile is still active makes them count
      // again at once: it takes a seat of the plan like any other professional (JD-S6 R1, A-T3). A
      // member with no profile takes none until the profile is made, which asks for the seat itself.
      if (input.newRoles.includes('professional') && !target.roles.includes('professional')) {
        const [profile] = await tx
          .select({ status: professional.status })
          .from(professional)
          .where(eq(professional.membershipId, target.id));
        if (profile?.status === 'active') await deps.seats?.assertAvailable(tx);
      }

      const previousRoles = target.roles;
      const roles = [...input.newRoles];
      await tx.update(membership).set({ roles }).where(eq(membership.id, target.id));
      // The member signs in again and gets the new roles: a promotion or demotion never rides on an
      // old session.
      await deps.sessions.revokeAllForUser(tx, target.userId, 'privilege_changed');
      await audit(tx, {
        action: 'role.changed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'membership',
        resourceId: target.id,
        metadata: { previousRoles, newRoles: roles },
      });
      // An admin who is not an owner added the professional role: leave a trace and tell the owners.
      const addedProfessional =
        roles.includes('professional') && !previousRoles.includes('professional');
      const notice = addedProfessional
        ? await prepareProfessionalAddedNotice(tx, {
            actor: input.actor,
            actorRoles: actor.roles,
            via: 'role_grant',
            membershipId: target.id,
            subjectName: await memberName(tx, target.id),
          })
        : null;
      return { roles, notice };
    },
  };
}
