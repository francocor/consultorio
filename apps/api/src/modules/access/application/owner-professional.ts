import { eq } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { lockOwnersAnd } from './members.js';
import { AccessRefused } from './refusal.js';

/**
 * Gives an owner the professional role on their own membership, as part of completing the
 * professional profile (decision D21, revised 2026-10-17): an owner MAY act as a health
 * professional at any time, provided the profile is complete. The caller completes the profile in
 * the same transaction (`OwnerProfessionalService`). This is the one sanctioned way a person adds
 * a role to themselves, and it is narrow on purpose:
 *
 * - it is read from the database, not from the session: the member must be an ACTIVE OWNER now;
 * - it adds `professional` and nothing else (the owner already controls the organization, so this
 *   is inside what an owner may hand out under decision D19);
 * - it is audited as a role change that says it came from the owner professional profile.
 *
 * There is no one-time limit, no wizard closure and no age window. Returns whether the role was
 * added (false when the owner already had it).
 */
export async function addProfessionalRoleToOwner(
  tx: Tx,
  input: { actor: AuditActor; membershipId: string },
): Promise<boolean> {
  const locked = await lockOwnersAnd(tx, [input.membershipId]);
  const member = locked.get(input.membershipId);
  if (!member) throw new AppError('not_found');
  if (member.status !== 'active' || !member.roles.includes('owner')) {
    throw new AccessRefused('owner_professional_not_owner');
  }
  if (member.roles.includes('professional')) return false;

  const newRoles = [...member.roles, 'professional'];
  await tx.update(membership).set({ roles: newRoles }).where(eq(membership.id, member.id));
  await audit(tx, {
    action: 'role.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'membership',
    resourceId: member.id,
    metadata: {
      previousRoles: member.roles,
      newRoles,
      via: 'owner_professional_profile',
      self: true,
    },
  });
  return true;
}
