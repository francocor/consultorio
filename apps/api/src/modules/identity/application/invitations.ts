import { createHash } from 'node:crypto';

import { ROLES, type Role } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { canGrantRoles } from '../domain/invitation-ceiling.js';
import type { PasswordValidator } from '../domain/password-policy.js';
import type { PasswordHasher } from '../infrastructure/argon2.js';

import { passwordFieldErrors } from './password-errors.js';

export interface IssueInvitationInput {
  /** Where the invitation is sent. */
  email: string;
  /** What the invitee will be: exactly these roles, no more. */
  roles: readonly Role[];
  /** Who invites, and what they hold: the roles must be inside their ceiling. */
  inviter: { userId: string; roles: readonly Role[] };
}

export interface IssuedInvitation {
  /** The raw token. Put it in the email link and forget it. */
  token: string;
  expiresAt: Date;
}

export interface AcceptInvitationInput {
  tenantId: string;
  token: string;
  password: string;
  actor: AuditActor;
}

export interface Invitations {
  /**
   * Issues the single-use link of a staff invitation. A newer invitation to the same address
   * replaces the older one. Throws `forbidden` if the roles go beyond what the inviter may grant.
   */
  issue(tx: Tx, input: IssueInvitationInput): Promise<IssuedInvitation>;
}

export interface InvitationAcceptance {
  /**
   * Accepts an invitation: creates the account (the invitee chooses the password) or links an
   * existing account to this organization. The roles are the invited ones, and the inviter must
   * STILL be allowed to grant them. An existing account keeps its password.
   */
  accept(input: AcceptInvitationInput): Promise<void>;
}

/** The invitation payload as stored in the token. */
interface InvitationPayload {
  email: string;
  roles: Role[];
  invitedBy: string;
}

function isRole(value: unknown): value is Role {
  return ROLES.some((role) => role === value);
}

function parsePayload(payload: Record<string, unknown>): InvitationPayload | null {
  const { email, roles, invitedBy } = payload;
  if (typeof email !== 'string' || typeof invitedBy !== 'string') return null;
  if (!Array.isArray(roles) || !roles.every(isRole)) return null;
  return { email, roles, invitedBy };
}

/** One stable id per (organization, address), so a new invitation can cancel the previous one. */
function subjectForAddress(address: string): string {
  const bytes = createHash('sha256').update(`invitation|${address.toLowerCase()}`).digest();
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function createInvitations(deps: { tokens: ActionTokens; clock?: () => Date }): Invitations {
  return {
    async issue(tx, input) {
      if (!canGrantRoles(input.inviter.roles, input.roles)) throw new AppError('forbidden');
      const email = input.email.trim().toLowerCase();
      const subjectId = subjectForAddress(email);
      await deps.tokens.revokeForSubject(tx, 'staff_invitation', subjectId);
      const issued = await deps.tokens.issue(tx, {
        kind: 'staff_invitation',
        subjectId,
        payload: { email, roles: [...input.roles], invitedBy: input.inviter.userId },
      });
      return { token: issued.token, expiresAt: issued.expiresAt };
    },
  };
}

export interface InvitationAcceptanceDeps {
  withTenant: WithTenant;
  tokens: ActionTokens;
  hasher: PasswordHasher;
  validator: PasswordValidator;
  clock?: () => Date;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
}

export function createInvitationAcceptance(deps: InvitationAcceptanceDeps): InvitationAcceptance {
  const clock = deps.clock ?? (() => new Date());

  return {
    async accept(input) {
      // 1. Look at the invitation without spending it: the password is checked against the
      // address it was sent to, and a bad password must not burn the invitation.
      const looked = await deps.withTenant(
        { tenantId: input.tenantId, userId: SYSTEM_USER_ID },
        async (tx) => {
          const seen = await deps.tokens.inspect(tx, 'staff_invitation', input.token);
          const invitation = seen ? parsePayload(seen.payload) : null;
          if (!invitation) return null;
          const found = await tx.execute<AccountRow>(
            sql`select id from app.lookup_user_for_login(${invitation.email})`,
          );
          return { invitation, existingId: found.rows[0]?.id ?? null };
        },
      );
      if (!looked) throw new AppError('bad_request');

      const verdict = await deps.validator.validate(input.password, {
        email: looked.invitation.email,
      });
      if (!verdict.ok) throw new AppError('validation_failed', passwordFieldErrors(verdict.issues));

      // An existing account is never given a new password by an invitation.
      const newAccount = looked.existingId === null;
      const passwordHash = newAccount ? await deps.hasher.hash(input.password) : null;
      const userId = looked.existingId ?? uuidv7();

      // 2. Spend the invitation and create everything in one transaction.
      await deps.withTenant({ tenantId: input.tenantId, userId }, async (tx) => {
        const redeemed = await deps.tokens.redeem(tx, 'staff_invitation', input.token);
        const invitation = redeemed ? parsePayload(redeemed.payload) : null;
        if (!invitation) throw new AppError('bad_request');

        const [inviter] = await tx
          .select({ roles: membership.roles, status: membership.status })
          .from(membership)
          .where(
            and(
              eq(membership.tenantId, input.tenantId),
              eq(membership.userId, invitation.invitedBy),
            ),
          );
        if (
          inviter?.status !== 'active' ||
          !canGrantRoles(inviter.roles as Role[], invitation.roles)
        ) {
          throw new AppError('forbidden');
        }

        const [existingMembership] = await tx
          .select({ id: membership.id })
          .from(membership)
          .where(and(eq(membership.tenantId, input.tenantId), eq(membership.userId, userId)));
        if (existingMembership) throw new AppError('conflict');

        if (passwordHash !== null) {
          await tx.insert(userAccount).values({
            id: userId,
            email: invitation.email,
            passwordHash,
            passwordChangedAt: clock(),
          });
        }
        const [created] = await tx
          .insert(membership)
          .values({ tenantId: input.tenantId, userId, roles: invitation.roles })
          .returning({ id: membership.id });
        await audit(tx, {
          action: 'auth.invitation.accepted',
          outcome: 'allow',
          actor: { ...input.actor, userId, actingRole: null },
          resourceType: 'membership',
          ...(created ? { resourceId: created.id } : {}),
          metadata: { roles: invitation.roles, newAccount },
        });
      });
    },
  };
}
