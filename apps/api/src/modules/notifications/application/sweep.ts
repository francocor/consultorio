import type { AppointmentStatus } from '@consultorio/contracts';
import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import { message, messageOffer } from '../../../db/schema/notifications.js';
import { appointment } from '../../../db/schema/scheduling.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { AppointmentFacts } from '../../../platform/events/appointment-events.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import { selectChannels } from '../domain/channel-policy.js';

import { rehashLegacyAddresses } from './address-rehash.js';
import { loadTenantState } from './context.js';
import type { MessagingDeps, TenantRef } from './deps.js';
import { createReminderPlanner } from './plan-reminders.js';
import { loadRecipient } from './recipients.js';
import { loadMessagingSettings } from './settings.js';

export const REMINDER_SWEEP_JOB = 'reminder.sweep';

/** How far ahead the sweep looks: longer than the longest lead time an organization can set. */
const HORIZON_DAYS = 45;

/** Appointments looked at per run, nearest first; the next run takes the rest. */
const BATCH = 500;

/**
 * A queued message this much past its time has no job left on the way: the platform cancelled it
 * while the organization was read-only (a retry waits minutes, not hours).
 */
const STALE_AFTER_MS = 2 * 3_600_000;

/** How long past its expiry the link of an offer is kept. */
const OFFER_LINK_GRACE_MS = 3_600_000;

const LIVE_MESSAGE = ['queued', 'sent', 'delivered', 'read'] as const;

/**
 * `reminder.sweep`, hourly per organization. It finds what the event-driven planner could not do
 * or cannot see:
 *
 * - An upcoming appointment whose patient has no automated channel gets the reception worklist
 *   item "reminder not sent" (once). When the contact is fixed the next sweep plans the reminders
 *   that were never planned and closes the item.
 * - The address hashes the log held before the platform pepper are replaced a batch at a time.
 * - A queued message long past its time is closed as cancelled, `tenant_read_only`: the platform
 *   cancels the sending job of a read-only organization before it runs, so only here does the
 *   message learn why it never went, and it is never sent after recovery.
 *
 * It never plans an appointment that already has messages (even cancelled ones: a patient who
 * opted out is not brought back) and never sends a confirmation: that answers a booking.
 */
export function createReminderSweepJob(deps: MessagingDeps) {
  const planner = createReminderPlanner({
    jobs: deps.jobs,
    clock: deps.clock,
    worklist: deps.worklist,
    whatsappAvailable: (tenant) => deps.channels.whatsapp(tenant) !== undefined,
  });

  async function closeStale(tx: Tx, now: Date): Promise<void> {
    await tx
      .update(message)
      .set({ status: 'cancelled', cancelReason: 'tenant_read_only' })
      .where(
        and(
          eq(message.status, 'queued'),
          lt(message.sendAt, new Date(now.getTime() - STALE_AFTER_MS)),
        ),
      );
  }

  /**
   * The link of a waitlist offer is worthless once the offer expired: it is not kept. An hour of
   * grace, so a message that was still being retried at the expiry finds what it needs.
   */
  async function clearExpiredOfferLinks(tx: Tx, now: Date): Promise<void> {
    await tx
      .update(messageOffer)
      .set({ url: null })
      .where(
        and(
          isNotNull(messageOffer.url),
          lt(messageOffer.expiresAt, new Date(now.getTime() - OFFER_LINK_GRACE_MS)),
        ),
      );
  }

  // Written with the table names spelled out: inside a one-table select Drizzle leaves columns
  // unqualified, and `id` would then mean the id of the inner table.
  const LIVE_SQL = sql.raw(LIVE_MESSAGE.map((status) => `'${status}'`).join(', '));
  const hasLiveMessage = sql<boolean>`exists (select 1 from message m where m.appointment_id = appointment.id and m.status in (${LIVE_SQL}))`;
  const wasPlanned = sql<boolean>`exists (select 1 from message m where m.appointment_id = appointment.id and m.planned_starts_at = appointment.starts_at)`;

  async function sweepAppointments(tx: Tx, tenantId: string, now: Date): Promise<void> {
    const settings = await loadMessagingSettings(tx);
    if (settings.notifications.reminderLeadHours.length === 0) return;
    const state = await loadTenantState(tx, tenantId);
    if (!state || state.isDemo) return;
    const tenant: TenantRef = { id: state.id, isDemo: false };

    const upcoming = await tx
      .select({
        id: appointment.id,
        patientId: appointment.patientId,
        professionalId: appointment.professionalId,
        locationId: appointment.locationId,
        appointmentTypeId: appointment.appointmentTypeId,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
        source: appointment.source,
        version: appointment.version,
        hasLive: hasLiveMessage,
        planned: wasPlanned,
      })
      .from(appointment)
      .where(
        and(
          inArray(appointment.status, ['scheduled', 'confirmed']),
          gt(appointment.startsAt, now),
          lt(appointment.startsAt, new Date(now.getTime() + HORIZON_DAYS * 86_400_000)),
        ),
      )
      .orderBy(asc(appointment.startsAt))
      .limit(BATCH);

    for (const row of upcoming) {
      const recipient = await loadRecipient(tx, row.patientId);
      const reachable =
        recipient !== null &&
        selectChannels('reminder', recipient.facts, {
          whatsappEnabled: settings.whatsappEnabled && deps.channels.whatsapp(tenant) !== undefined,
          whatsappQuotaAvailable: true,
        }).channels.length > 0;
      const subject = {
        kind: 'reminder_not_sent',
        subjectType: 'appointment',
        subjectId: row.id,
        locationId: row.locationId,
      } as const;

      if (!reachable) {
        if (!row.hasLive) await deps.worklist.open(tx, subject);
        continue;
      }
      let hasLive = row.hasLive;
      if (!row.planned) {
        const facts: AppointmentFacts = {
          appointmentId: row.id,
          patientId: row.patientId,
          professionalId: row.professionalId,
          locationId: row.locationId,
          appointmentTypeId: row.appointmentTypeId,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          status: row.status as AppointmentStatus,
          source: row.source === 'online' || row.source === 'waitlist_offer' ? row.source : 'staff',
          version: row.version,
        };
        await planner.plan(tx, facts, { confirm: false });
        const [after] = await tx
          .select({ live: hasLiveMessage })
          .from(appointment)
          .where(eq(appointment.id, row.id));
        hasLive = after?.live ?? false;
      }
      if (hasLive) await deps.worklist.close(tx, subject);
    }
  }

  return defineJob({
    name: REMINDER_SWEEP_JOB,
    category: 'write',
    payload: JobPayload,
    handler: async ({ tx, tenantId }) => {
      await rehashLegacyAddresses(tx);
      await closeStale(tx, deps.clock());
      await clearExpiredOfferLinks(tx, deps.clock());
      await sweepAppointments(tx, tenantId, deps.clock());
    },
  });
}
