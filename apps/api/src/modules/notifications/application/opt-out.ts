import { MESSAGE_CHANNELS } from '@consultorio/contracts';

import { describeFailure } from '../../../platform/db/failure-log.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { boundDelivery } from './offer-delivery.js';
import { recordOptOut, revokeWhatsappOptInLinks } from './preferences.js';

/** What an opt-out needs: who, where the patient said it, and who wrote it down. */
type OptOutInput = Omit<Parameters<typeof recordOptOut>[1], 'channel'>;

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

  if (recorded && optOutListener) {
    const listener = optOutListener;
    const now = boundDelivery()?.clock() ?? new Date();
    try {
      await tx.transaction((inner) => listener(inner, { patientId: input.patientId, now }));
    } catch (error) {
      reportListenerFailure(error);
    }
  }
  return { recorded, cancelled };
}
