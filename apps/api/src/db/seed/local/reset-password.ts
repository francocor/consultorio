import { eq } from 'drizzle-orm';

import { createLockout } from '../../../modules/identity/application/lockout.js';
import { createSessionService } from '../../../modules/identity/application/sessions.js';
import { createTwoFactor } from '../../../modules/identity/application/two-factor.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID } from '../../../platform/db/tenant-context.js';
import { membership, userAccount } from '../../schema/identity.js';

import { LocalProvisionError, normalizeEmail, type LocalProvisionDeps } from './provision.js';

export interface ResetOwnerPasswordInput {
  tenantId: string;
  newPassword: string;
  /** Which owner, when the organization has more than one. */
  ownerEmail?: string | undefined;
  /**
   * Also removes the owner's second factor and its recovery codes, for an owner who lost the phone.
   * Whoever can run this already controls the PC and the database, so it is not a gain of privilege.
   */
  clearSecondFactor?: boolean | undefined;
}

export interface ResetOwnerPasswordResult {
  email: string;
  /** True when the second factor was removed. */
  secondFactorCleared: boolean;
  /** True when the notice to the owner was written. A failure to write it never undoes the reset. */
  ownerNotified: boolean;
}

/**
 * The reset is done by whoever sits at the PC, not by the owner: the trail files it under the system and
 * says where it came from, so it cannot be mistaken for the owner changing their own password.
 */
const RESET_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: 'desktop-shell',
  requestId: null,
};

function noticeText(clearedSecondFactor: boolean, at: Date): string {
  return [
    'Hola,',
    '',
    `La contraseña de su cuenta de Consulvia se restableció desde la computadora del consultorio el ${at.toISOString()}.`,
    clearedSecondFactor
      ? 'También se quitó la verificación en dos pasos: vuelva a activarla desde su perfil.'
      : 'La verificación en dos pasos no cambió.',
    'Se cerraron todas las sesiones abiertas de su cuenta.',
    '',
    'Si usted no pidió este cambio, avise a quien administra la computadora: quien puede hacerlo tiene acceso al programa.',
  ].join('\n');
}

/**
 * Gives an owner a new password without the emailed link: the way back from a forgotten password on a
 * PC with no mail server (the tray offers it). Whoever can run it already controls the PC and its
 * database, so it asks for nothing but the new password, which follows the rules of the product.
 *
 * It does what completing a reset by email does: the sessions of the account end everywhere, a lock
 * from failed attempts is lifted, and the audit trail says so. It leaves the second factor alone unless
 * `clearSecondFactor` asks for it: a password reset must not remove the protection of the account by
 * itself, so the person at the PC says so on purpose.
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
  const twoFactor = createTwoFactor({ keys: deps.keys, withTenant: deps.withTenant, clock });
  const actor = RESET_ACTOR;
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
    if (input.clearSecondFactor === true) {
      await twoFactor.disable(tx, owner.userId);
      await audit(tx, {
        action: 'auth.2fa.disabled',
        outcome: 'allow',
        actor,
        resourceType: 'user',
        resourceId: owner.userId,
        reason: 'local_reset',
      });
    }
  });
  const cleared = input.clearSecondFactor === true;
  let ownerNotified = false;
  if (deps.email) {
    try {
      await deps.email.send({
        to: owner.email,
        subject: 'Consulvia: se restableció la contraseña de su cuenta',
        text: noticeText(cleared, clock()),
      });
      ownerNotified = true;
    } catch {
      // The reset is already done and filed: a notice that cannot be written must not undo it.
    }
  }
  return { email: owner.email, secondFactorCleared: cleared, ownerNotified };
}
