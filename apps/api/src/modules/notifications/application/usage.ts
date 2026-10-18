import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import { message } from '../../../db/schema/notifications.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import { whatsappUsageAlert, whatsappUsageEvent } from '../../../db/schema/usage-event.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { renderUsageAlertEmail } from '../assets/es-AR/usage-email.js';
import { periodOf, thresholdsReached } from '../domain/usage.js';

import type { Channels, TenantRef } from './deps.js';

/**
 * The monthly WhatsApp quota of each professional: the count, the port the plan plugs into, and the
 * warnings to the owner. Stage 6 (subscriptions) supplies the real `QuotaPolicy`; until then the
 * default allows everything and only counts, also where subscription billing is off.
 */

export interface QuotaPolicy {
  /**
   * The quota of a professional for a month. `limit: null` means no quota applies. With
   * `overageAllowed` the messages past the limit are sent and billed; without it they go by email.
   */
  limitFor(
    tx: Tx,
    professionalId: string,
    period: string,
  ): Promise<{ limit: number | null; overageAllowed: boolean }>;
}

/** The default: no quota, everything is allowed and everything is counted. */
export const UNLIMITED_QUOTA: QuotaPolicy = {
  limitFor: () => Promise.resolve({ limit: null, overageAllowed: true }),
};

/**
 * The time zone the months of the organization are counted in: the one of its first location. An
 * organization with no location yet counts in UTC.
 */
export async function organizationTimeZone(tx: Tx): Promise<string> {
  const [row] = await tx
    .select({ timeZone: location.timeZone })
    .from(location)
    .orderBy(asc(location.createdAt), asc(location.id))
    .limit(1);
  return row?.timeZone ?? 'UTC';
}

/** The month of an instant for this organization (see `organizationTimeZone`). */
export async function organizationPeriod(tx: Tx, instant: Date): Promise<string> {
  return periodOf(instant, await organizationTimeZone(tx));
}

/**
 * The messages that take a place of the quota: confirmed (the provider accepted them), or reserved
 * and still waiting to go. A reservation whose message ended without going (cancelled, failed) does
 * not count, whichever path ended it: the count does not depend on every such path remembering to
 * release (judgment day round 2, finding R2-C2). `excludeMessageId` leaves one message's own
 * place out, for the question "may THIS message go".
 */
export async function usageCount(
  tx: Tx,
  professionalId: string,
  period: string,
  excludeMessageId?: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(whatsappUsageEvent)
    .innerJoin(
      message,
      and(
        eq(message.tenantId, whatsappUsageEvent.tenantId),
        eq(message.id, whatsappUsageEvent.messageId),
      ),
    )
    .where(
      and(
        eq(whatsappUsageEvent.professionalId, professionalId),
        eq(whatsappUsageEvent.period, period),
        isNull(whatsappUsageEvent.releasedAt),
        or(isNotNull(whatsappUsageEvent.confirmedAt), eq(message.status, 'queued')),
        excludeMessageId === undefined
          ? undefined
          : ne(whatsappUsageEvent.messageId, excludeMessageId),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Whether one more WhatsApp message may go out for this professional now: there is no quota, the
 * plan allows overage, or the month's count is still under the limit. `ownMessageId` is the message
 * asking, when it may already hold a place.
 */
export async function whatsappQuotaAvailable(
  quota: QuotaPolicy,
  tx: Tx,
  professionalId: string,
  now: Date,
  ownMessageId?: string,
): Promise<boolean> {
  const period = await organizationPeriod(tx, now);
  const { limit, overageAllowed } = await quota.limitFor(tx, professionalId, period);
  if (limit === null || overageAllowed) return true;
  // A message that already holds a place (a retry) does not compete with itself for the last one.
  return (await usageCount(tx, professionalId, period, ownMessageId)) < limit;
}

/**
 * Takes a place of the quota for a message that is about to go over WhatsApp. Looking at the count
 * and writing the row are one step under a lock per professional and month, so two messages that
 * are prepared at the same moment cannot both take the last place (the check in
 * `whatsappQuotaAvailable` only chooses the channel; this is the one that decides). Asking again
 * for the same message returns the place it already has.
 */
export async function reserveWhatsappUsage(
  quota: QuotaPolicy,
  tx: Tx,
  input: { messageId: string; professionalId: string; now: Date },
): Promise<'reserved' | 'exhausted'> {
  const period = await organizationPeriod(tx, input.now);
  const { limit, overageAllowed } = await quota.limitFor(tx, input.professionalId, period);
  if (limit !== null && !overageAllowed) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`whatsapp-quota:${input.professionalId}:${period}`}, 0))`,
    );
    const [mine] = await tx
      .select({ id: whatsappUsageEvent.id })
      .from(whatsappUsageEvent)
      .where(
        and(
          eq(whatsappUsageEvent.messageId, input.messageId),
          isNull(whatsappUsageEvent.releasedAt),
        ),
      );
    if (mine) return 'reserved';
    if ((await usageCount(tx, input.professionalId, period)) >= limit) return 'exhausted';
  }
  await tx
    .insert(whatsappUsageEvent)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      messageId: input.messageId,
      professionalId: input.professionalId,
      countedAt: input.now,
      period,
    })
    .onConflictDoNothing();
  return 'reserved';
}

/**
 * Gives the place back: the messages did not go over WhatsApp. Nothing happens for one that had
 * none. A place the provider already accepted stays counted unless `includeConfirmed` says the
 * provider later reported the message undelivered.
 */
export async function releaseWhatsappUsage(
  tx: Tx,
  messageIds: string | readonly string[],
  options: { includeConfirmed?: boolean } = {},
): Promise<void> {
  const ids = typeof messageIds === 'string' ? [messageIds] : messageIds;
  if (ids.length === 0) return;
  await tx
    .update(whatsappUsageEvent)
    .set({ releasedAt: sql`now()` })
    .where(
      and(
        inArray(whatsappUsageEvent.messageId, [...ids]),
        options.includeConfirmed ? undefined : isNull(whatsappUsageEvent.confirmedAt),
        isNull(whatsappUsageEvent.releasedAt),
      ),
    );
}

async function ownerEmails(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ email: userAccount.email })
    .from(membership)
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .where(and(eq(membership.status, 'active'), sql`'owner' = any(${membership.roles})`));
  return rows.map((row) => row.email);
}

async function professionalName(tx: Tx, professionalId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: membership.displayName })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .where(eq(professional.id, professionalId));
  return row?.name ?? null;
}

export interface UsageDeps {
  quota: QuotaPolicy;
  channels: Channels;
}

/**
 * Counts a WhatsApp message the provider accepted against its professional, once, and warns the
 * owner the first time the month's count reaches 80% and 100% of the quota. A warning that cannot
 * be emailed does not undo the count (the owner sees the usage in the settings either way).
 */
export async function recordWhatsappUsage(
  deps: UsageDeps,
  tx: Tx,
  input: { messageId: string; professionalId: string; now: Date; tenant: TenantRef },
): Promise<{ counted: boolean }> {
  // The place was reserved when the message was prepared; one that was not (a caller that never
  // prepared) is taken now.
  await tx
    .insert(whatsappUsageEvent)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      messageId: input.messageId,
      professionalId: input.professionalId,
      countedAt: input.now,
      period: await organizationPeriod(tx, input.now),
    })
    .onConflictDoNothing();
  // Confirming is what counts "once": only the first acceptance finds it unconfirmed.
  const [confirmed] = await tx
    .update(whatsappUsageEvent)
    .set({ confirmedAt: input.now })
    .where(
      and(
        eq(whatsappUsageEvent.messageId, input.messageId),
        isNull(whatsappUsageEvent.confirmedAt),
      ),
    )
    .returning({ id: whatsappUsageEvent.id, period: whatsappUsageEvent.period });
  if (!confirmed) return { counted: false };
  const period = confirmed.period;

  const { limit } = await deps.quota.limitFor(tx, input.professionalId, period);
  const count = await usageCount(tx, input.professionalId, period);
  // The row is the "already told": a threshold crossed before is not announced again. One message
  // can cross both thresholds (a tiny quota); the owner gets one email, for the highest.
  let announce: 80 | 100 | null = null;
  for (const threshold of thresholdsReached(count, limit)) {
    const [alert] = await tx
      .insert(whatsappUsageAlert)
      .values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        professionalId: input.professionalId,
        period,
        threshold,
      })
      .onConflictDoNothing()
      .returning({ id: whatsappUsageAlert.id });
    if (alert) announce = threshold;
  }
  if (announce !== null && limit !== null) {
    await warnOwners(deps, tx, {
      tenant: input.tenant,
      professionalId: input.professionalId,
      threshold: announce,
      count,
      limit,
      period,
    });
  }
  return { counted: true };
}

async function warnOwners(
  deps: UsageDeps,
  tx: Tx,
  input: {
    tenant: TenantRef;
    professionalId: string;
    threshold: 80 | 100;
    count: number;
    limit: number;
    period: string;
  },
): Promise<void> {
  const sender = deps.channels.email(input.tenant);
  if (!sender) return;
  const email = renderUsageAlertEmail({
    organizationName: await readOrganizationName(tx),
    professionalName: await professionalName(tx, input.professionalId),
    threshold: input.threshold,
    count: input.count,
    limit: input.limit,
    period: input.period,
  });
  for (const to of await ownerEmails(tx)) {
    try {
      await sender.send({ to, ...email, tenant: input.tenant });
    } catch {
      // Best effort: see recordWhatsappUsage.
    }
  }
}
