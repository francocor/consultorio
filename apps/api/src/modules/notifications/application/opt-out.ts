import type { MessageChannel } from '@consultorio/contracts';
import { and, eq, inArray } from 'drizzle-orm';

import { message } from '../../../db/schema/notifications.js';
import { describeFailure } from '../../../platform/db/failure-log.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { selectChannels } from '../domain/channel-policy.js';

import { loadTenantState } from './context.js';
import { boundDelivery } from './offer-delivery.js';
import { recordOptOut } from './preferences.js';
import { dedupeKeyFor, groupHasChannel, groupKeyOf, queueMessage } from './queue.js';
import { loadRecipient } from './recipients.js';
import { loadMessagingSettings } from './settings.js';
import { UNLIMITED_QUOTA, whatsappQuotaAvailable } from './usage.js';

type OptOutInput = Parameters<typeof recordOptOut>[1];

/**
 * Who is told when a patient opts out (the waitlist closes their entries). Bound by the
 * composition root, in the transaction of the opt-out: another module's rule, run by messaging
 * without messaging knowing the module (judgment day finding B3).
 */
type OptOutListener = (tx: Tx, event: { patientId: string; now: Date }) => Promise<void>;
let optOutListener: OptOutListener | undefined;
let reportListenerFailure: (error: unknown) => void = defaultReport;

/**
 * One structured line on stderr, where the log shipper and the alerts read it: the class of the
 * error and its database code. Never the message, which can carry the statement and the values of
 * a row (a patient's address among them).
 */
function defaultReport(error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      msg: 'opt_out_listener_failed',
      ...describeFailure(error),
    })}
`,
  );
}

/**
 * Binds who is told of an opt-out. The listener runs in a savepoint of the opt-out's transaction:
 * if it fails, only its own work is undone, the failure is reported (`onFailure`, by default an
 * error line on stderr) and the patient's opt-out stands (judgment day round 2, finding A7).
 */
export function bindOptOutListener(
  listener: OptOutListener | undefined,
  options: { onFailure?: (error: unknown) => void } = {},
): void {
  optOutListener = listener;
  reportListenerFailure = options.onFailure ?? defaultReport;
}

export interface OptOutResult {
  recorded: boolean;
  /** Queued messages of the channel that were cancelled. */
  cancelled: number;
  /** Messages queued on the patient's other permitted channel to take their place. */
  replaced: number;
}

/**
 * Records an opt-out and keeps the patient informed on the channel they still allow (decision D10:
 * reminders are service communication, and an opt-out is per channel). What was queued on the
 * channel is cancelled at once, as the spec asks; each reminder or confirmation of an appointment
 * that was among them is queued again, for the same moment, on the next channel the policy allows
 * (an email that is not opted out, or WhatsApp with an opt-in) unless that reminder already has one.
 * A patient with no other channel gets nothing: the hourly sweep puts the appointment on the
 * reception worklist ("reminder not sent").
 *
 * The queue is the one the process bound when it built the notifications module; without a queue
 * there is nothing to send with and nothing is replaced.
 */
export async function optOutChannel(tx: Tx, input: OptOutInput): Promise<OptOutResult> {
  // What is about to be cancelled, read before the cancellation.
  const queued = await tx
    .select()
    .from(message)
    .where(
      and(
        eq(message.patientId, input.patientId),
        eq(message.channel, input.channel),
        eq(message.status, 'queued'),
        inArray(message.kind, ['reminder', 'confirmation']),
      ),
    );
  const recorded = await recordOptOut(tx, input);
  if (recorded.recorded && optOutListener) {
    const listener = optOutListener;
    const now = boundDelivery()?.clock() ?? new Date();
    try {
      await tx.transaction((inner) => listener(inner, { patientId: input.patientId, now }));
    } catch (error) {
      reportListenerFailure(error);
    }
  }
  const deps = boundDelivery();
  if (!recorded.recorded || deps === undefined || queued.length === 0) {
    return { ...recorded, replaced: 0 };
  }

  const state = await loadTenantState(tx, queued[0]?.tenantId ?? '');
  const recipient = await loadRecipient(tx, input.patientId);
  if (!state || state.status !== 'active' || state.isDemo || !recipient) {
    return { ...recorded, replaced: 0 };
  }
  const settings = await loadMessagingSettings(tx);
  const now = deps.clock();
  let replaced = 0;
  for (const row of queued) {
    if (row.appointmentId === null) continue;
    const kind = row.kind === 'confirmation' ? 'confirmation' : 'reminder';
    const decision = selectChannels(kind, recipient.facts, {
      whatsappEnabled:
        settings.whatsappEnabled && deps.whatsappAvailable({ id: state.id, isDemo: false }),
      whatsappQuotaAvailable:
        row.professionalId === null ||
        (await whatsappQuotaAvailable(deps.quota ?? UNLIMITED_QUOTA, tx, row.professionalId, now)),
    });
    const group = groupKeyOf(row.dedupeKey);
    let next: MessageChannel | undefined;
    for (const channel of decision.channels) {
      if (channel === input.channel || (await groupHasChannel(tx, group, channel))) continue;
      next = channel;
      break;
    }
    if (next === undefined) continue;
    await queueMessage(deps, tx, {
      kind,
      channel: next,
      patientId: row.patientId,
      appointmentId: row.appointmentId,
      professionalId: row.professionalId,
      plannedStartsAt: row.plannedStartsAt,
      appointmentVersion: row.appointmentVersion,
      // The same moment; a reminder that was due already goes now.
      sendAt: row.sendAt,
      dedupeKey: dedupeKeyFor(group, next),
      trigger: row.trigger === 'manual' ? 'manual' : 'automatic',
    });
    replaced += 1;
  }
  return { ...recorded, replaced };
}
