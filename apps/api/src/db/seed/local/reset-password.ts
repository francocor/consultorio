import { eq } from 'drizzle-orm';

import { createLockout } from '../../../modules/identity/application/lockout.js';
import { createSessionService } from '../../../modules/identity/application/sessions.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID } from '../../../platform/db/tenant-context.js';
import { membership, userAccount } from '../../schema/identity.js';

import { LocalProvisionError, normalizeEmail, type LocalProvisionDeps } from './provision.js';

export interface ResetOwnerPasswordInput {
  tenantId: string;
  newPassword: string;
  /** Which owner, when the organization has more than one. */
  ownerEmail?: string | undefined;
}

export interface ResetOwnerPasswordResult {
  email: string;
}

/**
 * Gives an owner a new password without the emailed link: the way back from a forgotten password on a
 * PC with no mail server (the tray offers it). Whoever can run it already controls the PC and its
 * database, so it asks for nothing but the new password, which follows the rules of the product.
 *
 * It does what completing a reset by email does: the sessions of the account end everywhere, a lock
 * from failed attempts is lifted, and the audit trail says so. It leaves the second factor alone: a
 * password reset must not also remove the protection of the account.
 */
export async function resetOwnerPassword(
  deps: LocalProvisionDeps,
  input: ResetOwnerPasswordInput,
): Promise<ResetOwnerPasswordResult> {
  const system = { tenantId: input.tenantId, userId: SYSTEM_USER_ID };
  const owners = await deps.withTenant(system, async (tx) => {
    const rows = await tx
      .select({ userId: membership.userId, email: userAccount.email, roles: membership.roles })
      .from(membership)
      .innerJoin(userAccount, eq(userAccount.id, membership.userId))
      .where(eq(membership.status, 'active'));
    return rows.filter((row) => row.roles.includes('owner'));
  });
  const wanted = input.ownerEmail === undefined ? undefined : normalizeEmail(input.ownerEmail);
  const matching =
    wanted === undefined ? owners : owners.filter((row) => normalizeEmail(row.email) === wanted);
  const [owner] = matching;
  if (!owner) throw new LocalProvisionError('owner_not_found');
  if (matching.length > 1) throw new LocalProvisionError('owner_ambiguous');

  const verdict = await deps.validator.validate(input.newPassword, { email: owner.email });
  if (!verdict.ok) throw new LocalProvisionError('password_rejected', verdict.issues);
  const passwordHash = await deps.hasher.hash(input.newPassword);

  const clock = deps.clock;
  const sessions = createSessionService({ clock });
  const lockout = createLockout({ clock });
  const actor: AuditActor = {
    userId: owner.userId,
    actingRole: null,
    ip: null,
    userAgent: 'reset-owner-password',
    requestId: null,
  };
  // The account policy only lets a transaction change the account it acts as.
  await deps.withTenant({ tenantId: input.tenantId, userId: owner.userId }, async (tx) => {
    await tx
      .update(userAccount)
      .set({ passwordHash, passwordChangedAt: clock() })
      .where(eq(userAccount.id, owner.userId));
    await lockout.reset(tx, owner.userId);
    await sessions.revokeEverywhere(tx, owner.userId, 'password_reset');
    await audit(tx, {
      action: 'auth.password.reset_completed',
      outcome: 'allow',
      actor,
      resourceType: 'user',
      resourceId: owner.userId,
      reason: 'local_reset',
    });
  });
  return { email: owner.email };
}
