import { and, eq, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { renderProfessionalAddedEmail } from '../../../platform/mail/templates.js';
import { readOrganizationName } from '../../tenancy/index.js';

/** What the owners are told after an admin brought a professional in (decision D19). */
export interface ProfessionalAddedNotice {
  /** Addresses of every active owner at the moment of the change. */
  recipients: string[];
  organizationName: string;
  adminName: string | undefined;
  subjectName: string | undefined;
  via: 'invitation' | 'role_grant';
}

export interface PrepareProfessionalNoticeInput {
  actor: AuditActor & { userId: string };
  actorRoles: readonly string[];
  via: 'invitation' | 'role_grant';
  /** The membership that received the role, or none yet when the person was only invited. */
  membershipId?: string;
  /** Name of the professional when known (the invitation's display name, the member's name). */
  subjectName?: string | undefined;
}

/**
 * Decision D19 (revised 2026-10-17): the owner AND the admin bring professionals in, and an admin
 * who is not an owner leaves a trace. Inside the transaction of the change this writes the audit
 * event `professional.added_by_admin` and reads the addresses of every active owner; the caller
 * sends the email once the transaction has committed (`sendProfessionalAddedNotice`).
 *
 * Returns null when nothing has to be told: the person who added the professional is an owner.
 */
export async function prepareProfessionalAddedNotice(
  tx: Tx,
  input: PrepareProfessionalNoticeInput,
): Promise<ProfessionalAddedNotice | null> {
  if (input.actorRoles.includes('owner')) return null;

  const owners = await tx
    .select({ email: userAccount.email })
    .from(membership)
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .where(and(eq(membership.status, 'active'), sql`'owner' = any(${membership.roles})`));
  const [admin] = await tx
    .select({ name: membership.displayName })
    .from(membership)
    .where(eq(membership.userId, input.actor.userId));
  const recipients = [...new Set(owners.map((owner) => owner.email.toLowerCase()))];

  await audit(tx, {
    action: 'professional.added_by_admin',
    outcome: 'allow',
    actor: input.actor,
    resourceType: input.via === 'invitation' ? 'invitation' : 'membership',
    ...(input.membershipId === undefined ? {} : { resourceId: input.membershipId }),
    metadata: { via: input.via, ownersNotified: recipients.length },
  });
  return {
    recipients,
    organizationName: await readOrganizationName(tx),
    adminName: admin?.name ?? undefined,
    subjectName: input.subjectName,
    via: input.via,
  };
}

export interface SendProfessionalNoticeInput {
  email: EmailSender;
  notice: ProfessionalAddedNotice;
  tenant: { id: string; isDemo: boolean };
  /** The staff screen of the organization, built from configuration. */
  link: string;
  /** Called with the failure when one address could not be reached. Never throws. */
  onFailure: (error: unknown) => void;
}

/**
 * Emails every active owner after the change committed. A provider failure is reported and does
 * not undo the change (the audit event is the record); the other owners are still tried.
 */
export async function sendProfessionalAddedNotice(
  input: SendProfessionalNoticeInput,
): Promise<void> {
  const { notice } = input;
  const rendered = renderProfessionalAddedEmail({
    organizationName: notice.organizationName,
    ...(notice.adminName === undefined ? {} : { adminName: notice.adminName }),
    ...(notice.subjectName === undefined ? {} : { subjectName: notice.subjectName }),
    via: notice.via,
    link: input.link,
  });
  const results = await Promise.allSettled(
    notice.recipients.map((to) => input.email.send({ to, tenant: input.tenant, ...rendered })),
  );
  for (const result of results) {
    if (result.status === 'rejected') input.onFailure(result.reason);
  }
}
