import { MESSAGE_CHANNELS, type MessageChannel } from '@consultorio/contracts';
import { and, eq, inArray } from 'drizzle-orm';

import { message } from '../../../db/schema/notifications.js';
import { describeFailure } from '../../../platform/db/failure-log.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { selectChannels } from '../domain/channel-policy.js';

import { loadTenantState } from './context.js';
import { boundDelivery } from './offer-delivery.js';
import { recordOptOut, revokeWhatsappOptInLinks } from './preferences.js';
import { dedupeKeyFor, groupHasChannel, groupKeyOf, queueMessage } from './queue.js';
import { loadRecipient } from './recipients.js';
import { loadMessagingSettings } from './settings.js';
import { UNLIMITED_QUOTA, whatsappQuotaAvailable } from './usage.js';

/** What an opt-out needs: who, where the patient said it, and who wrote it down. */
type OptOutInput = Omit<Parameters<typeof recordOptOut>[1], 'channel'>;

/**
 * Who is told when a patient opts out (the waitlist closes their entries). Bound by the
 * composition root, in the transaction of the opt-out: another module's rule, run by messaging
 * without messaging knowing the module (judgment day finding B3).
 */
/**
 * What the patient gave up: every channel (`all`, the waitlist closes every entry) or WhatsApp
 * alone (`whatsapp`, the waitlist closes the entries only when no channel is left).
 */
export type OptOutScope = 'all' | 'whatsapp';
type OptOutListener = (
  tx: Tx,
  event: { patientId: string; now: Date; scope: OptOutScope },
) => Promise<void>;
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
  /** False when the patient had opted out of every channel already: nothing changed. */
  recorded: boolean;
  /** Queued messages, of any channel and any kind, that were cancelled. */
  cancelled: number;
}

/**
 * Records that a patient does not want any message from the organization (owner decision B7:
 * opting out of one channel opts out of ALL of them). It is what a keyword on WhatsApp, the link
 * of an email and reception at the patient's request all call, whatever channel they were about.
 *
 * - Every channel gets its opt-out, and everything still queued for the patient (reminders,
 *   confirmations, waitlist offers, video follow-ups) is cancelled with the reason `opted_out`.
 *   Nothing takes its place: there is no other channel left to carry it (this replaces the "move
 *   it to the channel that is still allowed" of decision D10). The hourly sweep puts an appointment
 *   whose reminder is not sent on the reception worklist.
 * - The listener is told once, after every channel was recorded: the waitlist closes every entry
 *   of the patient.
 * - A link to accept WhatsApp that is still pending (decision D22 is kept: a number typed on a
 *   public form is only activated by that link) is revoked, even when WhatsApp had been opted out
 *   before: following a stale link later must never undo a BAJA.
 * - It is idempotent per channel: a channel that is already opted out keeps its first time and
 *   source, so a patient who opted out of one channel before B7 gets the other one recorded now.
 *
 * What still reaches an opted-out patient is only what they ask for at that very moment (the code
 * of an online booking or of a waitlist join, the confirmation of that booking, the links they
 * request); see `docs/` ("Messages that survive an opt-out") and the specs of notifications.
 */
export async function optOutPatient(tx: Tx, input: OptOutInput): Promise<OptOutResult> {
  let recorded = false;
  let cancelled = 0;
  let whatsappRecorded = false;
  for (const channel of MESSAGE_CHANNELS) {
    const result = await recordOptOut(tx, { ...input, channel });
    recorded ||= result.recorded;
    cancelled += result.cancelled;
    if (channel === 'whatsapp') whatsappRecorded = result.recorded;
  }
  // `recordOptOut` revokes the pending links when it records the WhatsApp opt-out; a link asked
  // for after an earlier one still has to die.
  if (!whatsappRecorded) await revokeWhatsappOptInLinks(tx, input.patientId);

  if (recorded) await tellListener(tx, input.patientId, 'all');
  return { recorded, cancelled };
}

/** Tells whoever is bound, in a savepoint: a failure there never undoes the patient's opt-out. */
async function tellListener(tx: Tx, patientId: string, scope: OptOutScope): Promise<void> {
  if (!optOutListener) return;
  const listener = optOutListener;
  const now = boundDelivery()?.clock() ?? new Date();
  try {
    await tx.transaction((inner) => listener(inner, { patientId, now, scope }));
  } catch (error) {
    reportListenerFailure(error);
  }
}

export interface WhatsappOptOutResult extends OptOutResult {
  /** Messages queued on email to take the place of the WhatsApp ones that were cancelled. */
  replaced: number;
}

/**
 * Closes WhatsApp for a patient and nothing else. It is for the people who share a WhatsApp number
 * with the patient who wrote BAJA (a family with one phone): the number cannot be written to any
 * more, but their email is not theirs to lose (owner decision B7, refined). Only the patient the
 * reply belongs to gets `optOutPatient`.
 *
 * What was queued on WhatsApp is cancelled at once; each reminder or confirmation of an
 * appointment that was among it is queued again, for the same moment, on email when the policy
 * allows it (the fallback of decision D10, kept for this case only) unless that reminder already
 * has one. The listener is told with the scope `whatsapp`: the waitlist keeps the entries of a
 * patient who still has an email and closes them when no channel is left. Pending links to accept
 * WhatsApp are revoked, even when WhatsApp had been opted out before.
 */
export async function optOutWhatsapp(tx: Tx, input: OptOutInput): Promise<WhatsappOptOutResult> {
  const channel: MessageChannel = 'whatsapp';
  // What is about to be cancelled, read before the cancellation.
  const queued = await tx
    .select()
    .from(message)
    .where(
      and(
        eq(message.patientId, input.patientId),
        eq(message.channel, channel),
        eq(message.status, 'queued'),
        inArray(message.kind, ['reminder', 'confirmation']),
      ),
    );
  const recorded = await recordOptOut(tx, { ...input, channel });
  if (!recorded.recorded) await revokeWhatsappOptInLinks(tx, input.patientId);
  else await tellListener(tx, input.patientId, 'whatsapp');

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
    for (const candidate of decision.channels) {
      if (candidate === channel || (await groupHasChannel(tx, group, candidate))) continue;
      next = candidate;
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
