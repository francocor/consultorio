import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import {
  inboundMessage,
  message,
  type INBOUND_OUTCOMES,
} from '../../../db/schema/notifications.js';
import { appointment } from '../../../db/schema/scheduling.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import { currentTenantId, type Tx } from '../../../platform/db/tenant-context.js';
import { hashAddress } from '../domain/address.js';
import { classifyReply } from '../domain/keywords.js';

import { loadAppointment, loadTenantState } from './context.js';
import type { Channels, Worklist } from './deps.js';
import { actForPatient, type PatientActionDeps } from './patient-actions.js';
import type { WhatsAppEvent } from './ports.js';
import { recordOptOut } from './preferences.js';

type InboundEvent = Extract<WhatsAppEvent, { kind: 'inbound' }>;
type InboundOutcome = (typeof INBOUND_OUTCOMES)[number];

/**
 * How a reply counts as "outstanding": a reminder or confirmation sent this recently that has not
 * been answered. Older ones are history, and a "1" for them would be a guess.
 */
const OUTSTANDING_DAYS = 7;

/** The text of a reply that reception reads is kept short: it is a pointer, not a transcript. */
const MAX_REVIEW_TEXT = 200;

export interface InboundDeps extends PatientActionDeps {
  channels: Channels;
  /** Opens the reception item for a reply nobody should act on by themselves. */
  worklist: Worklist;
  clock: () => Date;
}

export type InboundResult = 'duplicate' | InboundOutcome;

const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

/**
 * Handles one reply that reached an organization over WhatsApp (spec "Confirmation by the
 * patient", "Opt-out and consent"). The organization was found from OUR record of what it sent to
 * that number; the reply never says which one it is.
 *
 * - `BAJA` or `STOP` opts the patients that number was written about out of WhatsApp, and is
 *   answered with one acknowledgment.
 * - `1` confirms and `2` cancels the appointment of the outstanding reminder, but only when exactly
 *   one appointment is outstanding for that number. Two patients on one number, or none
 *   outstanding, change nothing and go to reception.
 * - Anything else changes nothing and goes to reception. A reply never opts anybody IN.
 * - A read-only organization still lets a patient cancel or opt out; it does not confirm.
 */
export async function processInbound(
  deps: InboundDeps,
  tx: Tx,
  event: InboundEvent,
  options: { from: string },
): Promise<InboundResult> {
  const tenantId = await currentTenantId(tx);
  const fromHash = hashAddress('whatsapp', options.from);
  const [recorded] = await tx
    .insert(inboundMessage)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      eventId: event.eventId,
      fromHash,
      outcome: 'ignored',
    })
    .onConflictDoNothing()
    .returning({ id: inboundMessage.id });
  if (!recorded) return 'duplicate';

  const finish = async (outcome: InboundOutcome): Promise<InboundResult> => {
    await tx.update(inboundMessage).set({ outcome }).where(eq(inboundMessage.id, recorded.id));
    return outcome;
  };

  const state = await loadTenantState(tx, tenantId);
  if (!state || state.isDemo) return finish('ignored');
  const active = state.status === 'active';
  const now = deps.clock();

  // The patients this organization wrote to on that number.
  const written = await tx
    .selectDistinct({ patientId: message.patientId })
    .from(message)
    .where(and(eq(message.channel, 'whatsapp'), eq(message.addressHash, fromHash)));
  const patientIds = written.map((row) => row.patientId);
  if (patientIds.length === 0) return finish('ignored');

  const review = async (): Promise<InboundResult> => {
    await deps.worklist.open(tx, {
      kind: 'reply_to_review',
      subjectType: 'inbound_message',
      subjectId: recorded.id,
      locationId: null,
      detail: { text: event.text.slice(0, MAX_REVIEW_TEXT), patientIds },
    });
    return finish('needs_review');
  };

  const kind = classifyReply(event.text);
  if (kind === 'opt_out') {
    for (const patientId of patientIds) {
      await recordOptOut(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'whatsapp_keyword',
        actor: SYSTEM_ACTOR,
      });
    }
    const sender = active ? deps.channels.whatsapp({ id: tenantId, isDemo: false }) : undefined;
    if (sender) {
      // One acknowledgment per reply: the key is the event, so a replay sends nothing more.
      await sender.send({
        templateKey: 'optout_ack',
        to: options.from,
        vars: {},
        idempotencyKey: `ack:${event.eventId}`,
      });
    }
    return finish('opted_out');
  }

  if (kind === 'other') return review();

  // 1 and 2 apply to the one appointment that is outstanding for this number.
  const outstanding = await tx
    .selectDistinct({ appointmentId: message.appointmentId })
    .from(message)
    .innerJoin(appointment, eq(appointment.id, message.appointmentId))
    .where(
      and(
        eq(message.channel, 'whatsapp'),
        eq(message.addressHash, fromHash),
        inArray(message.kind, ['reminder', 'confirmation']),
        inArray(message.status, ['sent', 'delivered', 'read']),
        gt(message.sentAt, new Date(now.getTime() - OUTSTANDING_DAYS * 86_400_000)),
        inArray(appointment.status, ['scheduled', 'confirmed']),
        gt(appointment.startsAt, now),
      ),
    );
  const [only, ...others] = outstanding;
  if (!only?.appointmentId || others.length > 0) return review();

  const target = await loadAppointment(tx, only.appointmentId);
  if (!target) return review();
  if (kind === 'confirm') {
    // A read-only organization does not confirm; the reply is left as it is.
    if (!active) return finish('ignored');
    if (target.status !== 'confirmed') {
      const done = await actForPatient(deps, tx, {
        appointment: target,
        action: 'confirm',
        now,
        actor: SYSTEM_ACTOR,
      });
      if (!done) return review();
    }
    return finish('confirmed');
  }
  const cancelled = await actForPatient(deps, tx, {
    appointment: target,
    action: 'cancel',
    now,
    actor: SYSTEM_ACTOR,
  });
  return cancelled ? finish('cancelled') : review();
}
