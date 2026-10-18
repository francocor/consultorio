import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import {
  inboundMessage,
  message,
  type INBOUND_OUTCOMES,
} from '../../../db/schema/notifications.js';
import { appointment } from '../../../db/schema/scheduling.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import { currentTenantId, type Tx } from '../../../platform/db/tenant-context.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { hashAddress, legacyAddressHash } from '../domain/address.js';
import { classifyReply } from '../domain/keywords.js';
import { withinCancelDeadline } from '../domain/validity.js';

import { loadAppointment, loadTenantState } from './context.js';
import type { Channels, Worklist } from './deps.js';
import { optOutChannel } from './opt-out.js';
import { actForPatient, type PatientActionDeps } from './patient-actions.js';
import type { WhatsAppEvent } from './ports.js';
import { loadMessagingSettings } from './settings.js';

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
 * - `BAJA`, `STOP`, `PARAR` or `NO MAS` opts the patients that number was written about out of
 *   WhatsApp, and is answered with one acknowledgment that names the organization.
 * - `1` confirms and `2` cancels the appointment of the outstanding reminder, but only when exactly
 *   one appointment is outstanding for that number (the one of the quoted message, when the reply
 *   quotes one). Two patients on one number, none outstanding, or another organization that could
 *   be the one the reply is about, change nothing and go to reception.
 * - `2` cancels only until the organization's deadline for changes by link, like the link of the
 *   reminder: later, the patient is told to contact the organization and reception is shown it.
 * - Anything else changes nothing and goes to reception. A reply never opts anybody IN.
 * - A read-only organization still lets a patient cancel or opt out; it does not confirm.
 */
export async function processInbound(
  deps: InboundDeps,
  tx: Tx,
  event: InboundEvent,
  options: {
    from: string;
    /** Another organization could be the one this reply is about: only an opt-out acts. */
    ambiguous?: boolean;
    /** The provider id of the message the reply quotes, already known to be this organization's. */
    quotedMessageId?: string;
  },
): Promise<InboundResult> {
  const tenantId = await currentTenantId(tx);
  const fromHash = hashAddress('whatsapp', options.from);
  // The log may still hold the unsalted hash of this number until the rehash has reached it.
  const knownHashes = [fromHash, legacyAddressHash('whatsapp', options.from)];
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
    .where(and(eq(message.channel, 'whatsapp'), inArray(message.addressHash, knownHashes)));
  const patientIds = written.map((row) => row.patientId);
  if (patientIds.length === 0) return finish('ignored');

  const review = async (
    reason?: 'several_organizations' | 'cancel_deadline',
  ): Promise<InboundResult> => {
    await deps.worklist.open(tx, {
      kind: 'reply_to_review',
      subjectType: 'inbound_message',
      subjectId: recorded.id,
      locationId: null,
      detail: {
        text: event.text.slice(0, MAX_REVIEW_TEXT),
        patientIds,
        ...(reason === undefined ? {} : { reason }),
      },
    });
    return finish('needs_review');
  };

  const kind = classifyReply(event.text);
  if (kind === 'opt_out') {
    for (const patientId of patientIds) {
      await optOutChannel(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'whatsapp_keyword',
        actor: SYSTEM_ACTOR,
      });
    }
    const sender = active ? deps.channels.whatsapp({ id: tenantId, isDemo: false }) : undefined;
    if (sender) {
      // One acknowledgment per reply and organization: the key is the event, so a replay sends nothing
      // more, and two organizations that answer the same reply do not collapse into one message.
      await sender.send({
        templateKey: 'optout_ack',
        to: options.from,
        vars: { organization: await readOrganizationName(tx) },
        idempotencyKey: `ack:${tenantId}:${event.eventId}`,
      });
    }
    return finish('opted_out');
  }

  if (kind === 'other') return review();
  // The reply may be about another organization's reminder: nothing is confirmed or cancelled here.
  if (options.ambiguous) return review('several_organizations');

  // 1 and 2 apply to the one appointment that is outstanding for this number.
  const outstanding = await tx
    .selectDistinct({ appointmentId: message.appointmentId })
    .from(message)
    .innerJoin(appointment, eq(appointment.id, message.appointmentId))
    .where(
      and(
        eq(message.channel, 'whatsapp'),
        inArray(message.addressHash, knownHashes),
        ...(options.quotedMessageId === undefined
          ? []
          : [eq(message.providerMessageId, options.quotedMessageId)]),
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
  const settings = await loadMessagingSettings(tx);
  if (
    !withinCancelDeadline({
      now,
      startsAt: target.startsAt,
      deadlineHours: settings.cancelDeadlineHours,
    })
  ) {
    const sender = active ? deps.channels.whatsapp({ id: tenantId, isDemo: false }) : undefined;
    if (sender) {
      await sender.send({
        templateKey: 'cancel_closed',
        to: options.from,
        vars: { organization: await readOrganizationName(tx) },
        idempotencyKey: `cancel-closed:${tenantId}:${event.eventId}`,
      });
    }
    return review('cancel_deadline');
  }
  const cancelled = await actForPatient(deps, tx, {
    appointment: target,
    action: 'cancel',
    now,
    actor: SYSTEM_ACTOR,
  });
  return cancelled ? finish('cancelled') : review();
}
