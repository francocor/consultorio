import { canGrantRoles, canManageRoles, type Role, type StaffRole } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { TOKEN_KIND_REGISTRY } from '../../../platform/tokens/kinds.js';
import {
  AccessRefused,
  countOtherActiveOwners,
  lockOwnersAnd,
  prepareProfessionalAddedNotice,
  type ProfessionalAddedNotice,
  type SessionRevoker,
} from '../../access/index.js';
import type { Invitations } from '../../identity/index.js';
import {
  assertProfessionalSeatAvailable,
  takesProfessionalSeat,
} from '../../subscriptions/index.js';
import { readOrganizationName } from '../../tenancy/index.js';

export interface InviteInput {
  actor: AuditActor & { userId: string };
  actorRoles: readonly Role[];
  email: string;
  roles: readonly StaffRole[];
  displayName?: string | undefined;
}

export interface PreparedInvitation {
  email: string;
  token: string;
  expiresAt: Date;
  organizationName: string;
  inviterName: string | null;
  expiresInDays: number;
  /** Set when an admin who is not an owner invited a professional (decision D19). */
  ownerNotice: ProfessionalAddedNotice | null;
}

export interface StatusChangeInput {
  actor: AuditActor & { userId: string };
  actorMembershipId: string;
  targetMembershipId: string;
}

export interface LifecycleService {
  /** Issues the single-use link; the caller sends it once the transaction has committed. */
  prepareInvitation(tx: Tx, input: InviteInput): Promise<PreparedInvitation>;
  deactivate(tx: Tx, input: StatusChangeInput): Promise<'deactivated'>;
  reactivate(tx: Tx, input: StatusChangeInput): Promise<'active'>;
}

const DAY_MS = 24 * 3_600_000;
const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

export function createLifecycleService(deps: {
  invitations: Invitations;
  sessions: SessionRevoker;
}): LifecycleService {
  /** The fresh state of the actor and the target, with the owners locked. */
  async function lockedPair(tx: Tx, input: StatusChangeInput) {
    const locked = await lockOwnersAnd(tx, [input.actorMembershipId, input.targetMembershipId]);
    const target = locked.get(input.targetMembershipId);
    if (!target) throw new AppError('not_found');
    const actor = locked.get(input.actorMembershipId);
    if (
      actor?.status !== 'active' ||
      !(actor.roles.includes('owner') || actor.roles.includes('admin'))
    ) {
      throw new AccessRefused('staff_status_actor');
    }
    if (actor.id === target.id) throw new AccessRefused('staff_status_self');
    if (!canManageRoles(actor.roles as Role[], target.roles as Role[])) {
      throw new AccessRefused('staff_status_above_ceiling');
    }
    return { locked, actor, target };
  }

  return {
    async prepareInvitation(tx, input) {
      if (!canGrantRoles(input.actorRoles, input.roles)) {
        throw new AccessRefused('invite_above_ceiling');
      }
      // A professional takes a priced seat of the plan (Stage 6): the limit is enforced here.
      if (takesProfessionalSeat(input.roles)) await assertProfessionalSeatAvailable(tx);
      const email = input.email.trim().toLowerCase();

      // Someone who already works here (or worked here) is reactivated, not invited again.
      const [member] = await tx
        .select({ id: membership.id })
        .from(membership)
        .innerJoin(userAccount, eq(userAccount.id, membership.userId))
        .where(eq(userAccount.email, email));
      if (member) throw new AppError('conflict');

      const issued = await deps.invitations.issue(tx, {
        email,
        roles: input.roles,
        inviter: { userId: input.actor.userId, roles: input.actorRoles },
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      });
      await audit(tx, {
        action: 'staff.invited',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'invitation',
        metadata: { roles: [...input.roles] },
      });

      // An admin who is not an owner invited a professional: leave a trace and tell the owners
      // (decision D19). The owner who invites a professional needs neither.
      const ownerNotice = input.roles.includes('professional')
        ? await prepareProfessionalAddedNotice(tx, {
            actor: input.actor,
            actorRoles: input.actorRoles,
            via: 'invitation',
            subjectName: input.displayName,
          })
        : null;

      const [inviter] = await tx
        .select({ name: membership.displayName })
        .from(membership)
        .where(eq(membership.userId, input.actor.userId));
      return {
        email,
        token: issued.token,
        expiresAt: issued.expiresAt,
        organizationName: await readOrganizationName(tx),
        inviterName: inviter?.name ?? null,
        expiresInDays: Math.round(TOKEN_KIND_REGISTRY.staff_invitation.ttlMs / DAY_MS),
        ownerNotice,
      };
    },

    async deactivate(tx, input) {
      const { locked, target } = await lockedPair(tx, input);
      if (target.status === 'deactivated') return 'deactivated';
      if (target.roles.includes('owner') && countOtherActiveOwners(locked, target.id) === 0) {
        throw new AccessRefused('staff_deactivate_last_owner');
      }

      await tx
        .update(membership)
        .set({ status: 'deactivated' })
        .where(eq(membership.id, target.id));
      // The profile stays (the authorship of past records does); it only stops being active.
      await tx
        .update(professional)
        .set({ status: 'inactive' })
        .where(eq(professional.membershipId, target.id));
      await deps.sessions.revokeAllForUser(tx, target.userId, 'deactivated');
      await audit(tx, {
        action: 'staff.deactivated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'membership',
        resourceId: target.id,
      });
      return 'deactivated';
    },

    async reactivate(tx, input) {
      const { target } = await lockedPair(tx, input);
      if (target.status === 'active') return 'active';

      // Bringing a professional back takes their seat again (Stage 6): the plan limit applies.
      const [dormant] = await tx
        .select({ id: professional.id })
        .from(professional)
        .where(and(eq(professional.membershipId, target.id), eq(professional.status, 'inactive')));
      if (dormant) await assertProfessionalSeatAvailable(tx);

      try {
        await tx.update(membership).set({ status: 'active' }).where(eq(membership.id, target.id));
        await tx
          .update(professional)
          .set({ status: 'active' })
          .where(eq(professional.membershipId, target.id));
      } catch (error) {
        if (sqlState(error) === UNIQUE_VIOLATION) {
          // Another active professional holds the registration now.
          throw new AppError('conflict', [
            { path: 'matricula', i18nKey: 'staff.matricula.duplicate' },
          ]);
        }
        throw error;
      }
      await audit(tx, {
        action: 'staff.reactivated',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'membership',
        resourceId: target.id,
      });
      return 'active';
    },
  };
}
