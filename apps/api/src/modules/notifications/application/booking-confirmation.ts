import { and, eq, sql } from 'drizzle-orm';

import { message, messageAttempt } from '../../../db/schema/notifications.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { RenderedEmail } from '../../../platform/mail/templates.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import type { BookingNotice, BookingNotifier } from '../../online-booking/index.js';
import { hashAddress } from '../domain/address.js';
import { classifyEmailFailure, MAX_ATTEMPTS } from '../domain/delivery-rules.js';

import { loadTenantState } from './context.js';
import { optInPayload } from './whatsapp-opt-in.js';

/**
 * The confirmation of an online booking, as the notifications module sends it (spec "Automatic
 * reminders": a confirmation that answers an action of the patient is exempt from quiet hours; D5:
 * the booking flow tells the patient on the channel the visitor verified).
 *
 * - It goes to the address the visitor verified with the code, not to the one on the patient's
 *   record: for a patient who already existed, that is the way the visitor proved they control.
 * - It is a message of the log (kind `confirmation`, on the appointment), with its attempts, so
 *   reception sees it was sent. The log keeps a hash of the address, never the address.
 * - It is sent once per appointment and time: asking again for the same booking changes nothing,
 *   and moving the appointment (another time) is a new confirmation.
 * - It does not depend on the opt-outs of the record of the patient: the address is the
 *   visitor's own, proved a moment ago, and the message answers what they just did. (An opt-out of
 *   a record the visitor may not even own must not decide whether they are answered: it would tell
 *   them that the document is on file.) The sender is routed by organization: a demonstration
 *   organization's confirmation goes to the fake (or, in development, to the local mail catcher
 *   that the demo stack and its end-to-end suite read), never to a real mailbox.
 * - A temporary failure is tried again, up to three attempts in all, a few seconds apart (the
 *   visitor is not waiting: it runs after their answer). A failure never reaches the visitor.
 */

const RETRY_WAITS_MS = [2_000, 8_000] as const;

export interface BookingNotifierDeps {
  withTenant: WithTenant;
  /** Routed by organization: a demonstration organization never reaches a real mail server. */
  email: EmailSender;
  clock: () => Date;
  /** Issues the link with which a patient accepts WhatsApp. */
  tokens: ActionTokens;
  /** Writes the email (the details and the link to change the booking). */
  compose(notice: BookingNotice): RenderedEmail;
  /** Replaced in tests, so they do not sleep. */
  wait?: (ms: number) => Promise<void>;
}

export function createBookingNotifier(deps: BookingNotifierDeps): BookingNotifier {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  /** Logs the message and its first attempt. Null when there is nothing to send. */
  async function begin(notice: BookingNotice): Promise<string | null> {
    return deps.withTenant(
      { tenantId: notice.tenant.id, userId: SYSTEM_USER_ID },
      async (tx): Promise<string | null> => {
        const state = await loadTenantState(tx, notice.tenant.id);
        if (!state || state.status !== 'active') return null;
        const [inserted] = await tx
          .insert(message)
          .values({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            kind: 'confirmation',
            channel: 'email',
            patientId: notice.patientId,
            appointmentId: notice.appointmentId,
            plannedStartsAt: notice.startsAt,
            sendAt: deps.clock(),
            // One confirmation per appointment and time.
            dedupeKey: `booking_confirmation:${notice.appointmentId}:${String(notice.startsAt.getTime())}:email`,
            addressHash: hashAddress('email', notice.to),
            attempts: 1,
          })
          .onConflictDoNothing()
          .returning({ id: message.id });
        if (!inserted) return null;
        await tx.insert(messageAttempt).values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          messageId: inserted.id,
          attemptNo: 1,
          outcome: 'started',
        });
        return inserted.id;
      },
    );
  }

  /** Records how an attempt ended, and the message with it when that was the last one. */
  async function settle(
    notice: BookingNotice,
    messageId: string,
    attemptNo: number,
    outcome:
      { kind: 'accepted' } | { kind: 'retryable' } | { kind: 'rejected' } | { kind: 'exhausted' },
  ): Promise<void> {
    await deps.withTenant({ tenantId: notice.tenant.id, userId: SYSTEM_USER_ID }, async (tx) => {
      const recorded = outcome.kind === 'exhausted' ? 'retryable' : outcome.kind;
      await tx
        .update(messageAttempt)
        .set({ outcome: recorded })
        .where(
          and(eq(messageAttempt.messageId, messageId), eq(messageAttempt.attemptNo, attemptNo)),
        );
      const settled = (patch: Partial<typeof message.$inferInsert>) =>
        tx
          .update(message)
          .set({ attempts: attemptNo, ...patch })
          .where(and(eq(message.id, messageId), eq(message.status, 'queued')));
      if (outcome.kind === 'accepted') await settled({ status: 'sent', sentAt: deps.clock() });
      else if (outcome.kind === 'rejected') {
        await settled({ status: 'failed', failureReason: 'mailbox_unavailable' });
      } else if (outcome.kind === 'exhausted') {
        await settled({ status: 'failed', failureReason: 'retries_exhausted' });
      } else {
        // A new attempt follows: the next one is logged before it is made.
        await tx.insert(messageAttempt).values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          messageId,
          attemptNo: attemptNo + 1,
          outcome: 'started',
        });
        await settled({ attempts: attemptNo + 1 });
      }
    });
  }

  return {
    requestWhatsAppOptIn: async (tx, input) => {
      // A number typed into a public form is nobody's yet: the choice waits for the patient to
      // follow a link sent to the address that was verified. Every submission that ticked the box
      // gets its link, whoever the document belongs to (judgment day round 2, finding A1).
      const issued = await deps.tokens.issue(tx, {
        kind: 'whatsapp_opt_in',
        subjectId: input.submissionId,
        payload: optInPayload(input),
      });
      return { token: issued.token };
    },

    async confirmBooking(notice) {
      const messageId = await begin(notice);
      if (messageId === null) return;
      const content = deps.compose(notice);
      for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo += 1) {
        try {
          await deps.email.send({
            to: notice.to,
            tenant: { id: notice.tenant.id, isDemo: notice.tenant.isDemo },
            ...content,
          });
          await settle(notice, messageId, attemptNo, { kind: 'accepted' });
          return;
        } catch (error) {
          if (classifyEmailFailure(error) === 'permanent') {
            await settle(notice, messageId, attemptNo, { kind: 'rejected' });
            return;
          }
          if (attemptNo >= MAX_ATTEMPTS) {
            await settle(notice, messageId, attemptNo, { kind: 'exhausted' });
            return;
          }
          await settle(notice, messageId, attemptNo, { kind: 'retryable' });
          await wait(
            RETRY_WAITS_MS[attemptNo - 1] ?? RETRY_WAITS_MS[RETRY_WAITS_MS.length - 1] ?? 0,
          );
        }
      }
    },
  };
}
