import { applyQuietHours, type QuietWindow } from './quiet-hours.js';

/**
 * The reminders of one appointment (spec "Automatic reminders"). Pure: it turns the lead times of
 * the organization, the quiet hours and the clock into the messages to queue, and says what it
 * left out and why.
 */

const HOUR_MS = 3_600_000;

export interface PlannedReminder {
  leadHours: number;
  sendAt: Date;
}

export interface ReminderPlan {
  /** In the order they fall due. */
  reminders: PlannedReminder[];
  /** Lead times whose reminder fell in quiet hours and could not be deferred before the start. */
  quietSkipped: number[];
  /** Lead times that were already past when the plan was made. */
  overdue: number[];
  /**
   * True when a reminder was overdue for an appointment that has not started: the patient is told
   * of the appointment with a confirmation, sent at once.
   */
  confirmNow: boolean;
}

export function planReminders(input: {
  now: Date;
  startsAt: Date;
  timeZone: string;
  /** The organization's lead times, in hours before the start. */
  leadHours: readonly number[];
  quiet: QuietWindow;
}): ReminderPlan {
  const plan: ReminderPlan = { reminders: [], quietSkipped: [], overdue: [], confirmNow: false };
  if (input.startsAt.getTime() <= input.now.getTime()) return plan;

  const leads = [...new Set(input.leadHours)].sort((a, b) => b - a);
  for (const leadHours of leads) {
    const due = new Date(input.startsAt.getTime() - leadHours * HOUR_MS);
    if (due.getTime() <= input.now.getTime()) {
      plan.overdue.push(leadHours);
      continue;
    }
    const decision = applyQuietHours({
      due,
      startsAt: input.startsAt,
      timeZone: input.timeZone,
      quiet: input.quiet,
    });
    if (decision.kind === 'skip') plan.quietSkipped.push(leadHours);
    else plan.reminders.push({ leadHours, sendAt: decision.at });
  }
  plan.confirmNow = plan.overdue.length > 0;
  return plan;
}
