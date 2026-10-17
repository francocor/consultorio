import { and, eq } from 'drizzle-orm';

import { message } from '../../../db/schema/notifications.js';
import { location } from '../../../db/schema/tenant.js';
import { currentTenantId, type Tx } from '../../../platform/db/tenant-context.js';
import type {
  AppointmentEvent,
  AppointmentFacts,
} from '../../../platform/events/appointment-events.js';
import { selectChannels } from '../domain/channel-policy.js';
import { planReminders } from '../domain/reminder-plan.js';

import { loadTenantState } from './context.js';
import type { MessagingDeps, TenantRef } from './deps.js';
import { dedupeKeyFor, queueMessage } from './queue.js';
import { loadRecipient } from './recipients.js';
import { loadMessagingSettings } from './settings.js';

/**
 * Keeps the reminder queue of an appointment right, from the appointment events and nothing else:
 * scheduling never calls messaging (stage 3 seam). It runs inside the transaction of the booking,
 * the move or the cancellation, so the queue and the appointment cannot disagree.
 *
 * - A new appointment (or one just approved, or one brought back) gets its reminders queued at
 *   each lead time of the organization, in the zone of the location.
 * - A move, a change of professional or of patient cancels what was queued for the old appointment
 *   and plans again from the new one.
 * - A cancellation, an attendance or a no-show cancels what is still queued.
 * - A reminder that is already overdue is not queued; the patient gets the confirmation at once.
 * - A reminder that quiet hours would push past the start is not queued; reception is told.
 */

export type PlannerDeps = Pick<MessagingDeps, 'jobs' | 'clock' | 'worklist'> & {
  /** False when no WhatsApp provider serves this organization. */
  whatsappAvailable(tenant: TenantRef): boolean;
};

/** The statuses in which an appointment still has reminders to send. */
const REMINDING: ReadonlySet<string> = new Set(['scheduled', 'confirmed']);

/** The statuses that end the use of what is still queued. */
const FINISHED: ReadonlySet<string> = new Set(['checked_in', 'in_progress', 'attended', 'no_show']);

export interface PlanOptions {
  /** False for a plan made long after the booking: it queues reminders still ahead, never a confirmation. */
  confirm?: boolean;
}

export interface ReminderPlanner {
  handle(tx: Tx, event: AppointmentEvent): Promise<void>;
  /** Plans the reminders of an appointment that has none (the sweep uses it). Idempotent. */
  plan(tx: Tx, appointment: AppointmentFacts, options?: PlanOptions): Promise<void>;
}

async function cancelQueued(
  tx: Tx,
  appointmentId: string,
  reason: 'appointment_cancelled' | 'appointment_changed' | 'appointment_over',
): Promise<void> {
  await tx
    .update(message)
    .set({ status: 'cancelled', cancelReason: reason })
    .where(and(eq(message.appointmentId, appointmentId), eq(message.status, 'queued')));
}

export function createReminderPlanner(deps: PlannerDeps): ReminderPlanner {
  async function plan(
    tx: Tx,
    appointment: AppointmentFacts,
    options: PlanOptions = {},
  ): Promise<void> {
    if (!REMINDING.has(appointment.status)) return;
    const now = deps.clock();
    const tenantId = await currentTenantId(tx);
    const settings = await loadMessagingSettings(tx);
    const state = await loadTenantState(tx, tenantId);
    const recipient = await loadRecipient(tx, appointment.patientId);
    const [zone] = await tx
      .select({ timeZone: location.timeZone })
      .from(location)
      .where(eq(location.id, appointment.locationId));
    if (!state || !zone) return;
    const timeZone = zone.timeZone;

    const result = planReminders({
      now,
      startsAt: appointment.startsAt,
      timeZone,
      leadHours: settings.notifications.reminderLeadHours,
      quiet: settings.quietHours,
    });
    const tenant: TenantRef = { id: state.id, isDemo: state.isDemo };
    const channelFor = (kind: 'reminder' | 'confirmation') => {
      if (!recipient) return undefined;
      return selectChannels(kind, recipient.facts, {
        whatsappEnabled: settings.whatsappEnabled && deps.whatsappAvailable(tenant),
        whatsappQuotaAvailable: true,
      }).channels[0];
    };

    const common = {
      patientId: appointment.patientId,
      appointmentId: appointment.appointmentId,
      professionalId: appointment.professionalId,
      plannedStartsAt: appointment.startsAt,
      appointmentVersion: appointment.version,
    };
    const keyOf = (name: string) =>
      `${name}:${appointment.appointmentId}:v${String(appointment.version)}`;

    const reminderChannel = channelFor('reminder');
    const anyReminderWanted =
      result.reminders.length > 0 || (options.confirm !== false && result.confirmNow);
    for (const reminder of result.reminders) {
      if (reminderChannel === undefined) break;
      await queueMessage(deps, tx, {
        ...common,
        kind: 'reminder',
        channel: reminderChannel,
        sendAt: reminder.sendAt,
        dedupeKey: dedupeKeyFor(
          `${keyOf('reminder')}:l${String(reminder.leadHours)}`,
          reminderChannel,
        ),
      });
    }

    const confirmationChannel = channelFor('confirmation');
    if (options.confirm !== false && result.confirmNow && confirmationChannel !== undefined) {
      await queueMessage(deps, tx, {
        ...common,
        kind: 'confirmation',
        channel: confirmationChannel,
        // A confirmation answers an action of staff or of the patient: it ignores quiet hours.
        sendAt: now,
        dedupeKey: dedupeKeyFor(keyOf('confirmation'), confirmationChannel),
      });
    }

    const unreachable = reminderChannel === undefined && anyReminderWanted;
    if (unreachable || result.quietSkipped.length > 0) {
      await deps.worklist.open(tx, {
        kind: 'reminder_not_sent',
        subjectType: 'appointment',
        subjectId: appointment.appointmentId,
        locationId: appointment.locationId,
      });
    }
  }

  return {
    plan,
    async handle(tx, event) {
      switch (event.kind) {
        case 'created':
          await plan(tx, event.appointment);
          return;
        case 'cancelled':
          await cancelQueued(tx, event.appointment.appointmentId, 'appointment_cancelled');
          return;
        case 'rescheduled':
        case 'reassigned':
        case 'patient_changed':
          await cancelQueued(tx, event.appointment.appointmentId, 'appointment_changed');
          await plan(tx, event.appointment);
          return;
        case 'status_changed':
          if (FINISHED.has(event.appointment.status)) {
            await cancelQueued(tx, event.appointment.appointmentId, 'appointment_over');
          } else if (REMINDING.has(event.appointment.status) && !REMINDING.has(event.fromStatus)) {
            // Approved, or put back after a correction: the reminders start from here.
            await plan(tx, event.appointment);
          }
          return;
        case 'slot_freed':
          return;
      }
    },
  };
}
