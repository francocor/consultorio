import type {
  MessageCancelReason,
  MessageChannel,
  MessageFailureReason,
  MessageKind,
  MessageStatus,
} from '@consultorio/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { optOutPatient } from '../../../../modules/notifications/application/opt-out.js';
import { recordOptIn } from '../../../../modules/notifications/application/preferences.js';
import { hashAddress } from '../../../../modules/notifications/domain/address.js';
import { normalizeWhatsAppNumber } from '../../../../modules/notifications/domain/phone.js';
import type { Tx } from '../../../../platform/db/tenant-context.js';
import {
  inboundMessage,
  message,
  messageAttempt,
  messageEvent,
  messageOffer,
} from '../../../schema/notifications.js';
import { patient } from '../../../schema/patients.js';
import { appointment } from '../../../schema/scheduling.js';
import { whatsappUsageEvent } from '../../../schema/usage-event.js';
import { waitlistOffer } from '../../../schema/waitlist.js';

import type { OnlineBookingSeed } from './online-booking.js';
import { actorOf, anonymous, systemOf, type Stage3Context } from './shared.js';
import type { TeleconsultationSeed } from './teleconsultation.js';
import type { WaitlistSeed } from './waitlist.js';

/**
 * The message log of the demo (tasks 3.71): what reminders, confirmations, an offer and a video
 * link left behind, in every status, with the choices of the patients that explain them. It is
 * metadata only, like the real log (no text, no address): the seed writes rows and nothing else.
 * A demonstration organization never sends a message; if its worker ever picks up a message of a
 * demonstration organization it cancels it with the reason `demo_tenant`, and one of the rows below
 * shows exactly that.
 *
 * The statuses are a story, not a count: a reminder that was read, one that was only delivered,
 * one WhatsApp refused for good and email then carried, a confirmation, a reminder that still waits,
 * one cancelled because the patient opted out of email, one cancelled for being a demonstration,
 * and a reply that confirmed an appointment.
 */

const HOUR = 3_600_000;

interface Row {
  kind: MessageKind;
  channel: MessageChannel;
  status: MessageStatus;
  patientId: string;
  appointmentId: string | null;
  professionalId: string | null;
  plannedStartsAt: Date | null;
  appointmentVersion: number | null;
  sendAt: Date;
  /** Where it went, for the hash (a lower-case email or a number); never stored. */
  address: string | null;
  cancelReason?: MessageCancelReason;
  failureReason?: MessageFailureReason;
  videoPending?: boolean;
  /** The status events the provider reported, in order (WhatsApp only). */
  events?: ('sent' | 'delivered' | 'read' | 'failed')[];
  /** The key of the group the message belongs to (a fallback shares it). */
  group: string;
}

interface Known {
  id: string;
  startsAt: Date;
  version: number;
  status: string;
  patientId: string;
  professionalId: string;
  email: string | null;
  phone: string | null;
}

const lower = (value: string | null) => value?.trim().toLowerCase() ?? null;

async function loadKnown(tx: Tx, ids: readonly string[]): Promise<Known[]> {
  if (ids.length === 0) return [];
  return tx
    .select({
      id: appointment.id,
      startsAt: appointment.startsAt,
      version: appointment.version,
      status: appointment.status,
      patientId: appointment.patientId,
      professionalId: appointment.professionalId,
      email: patient.email,
      phone: patient.phone,
    })
    .from(appointment)
    .innerJoin(patient, eq(patient.id, appointment.patientId))
    .where(inArray(appointment.id, [...ids]))
    .orderBy(asc(appointment.startsAt), asc(appointment.id));
}

/** The number a WhatsApp message would go to: the way the product normalizes it. */
const whatsappNumber = (phone: string | null) =>
  phone === null ? null : (normalizeWhatsAppNumber(phone) ?? phone);

const periodOf = (instant: Date) =>
  `${String(instant.getUTCFullYear())}-${String(instant.getUTCMonth() + 1).padStart(2, '0')}`;

export async function seedNotifications(
  input: Stage3Context,
  sources: {
    teleconsultation: TeleconsultationSeed;
    onlineBooking: OnlineBookingSeed;
    waitlist: WaitlistSeed;
  },
): Promise<void> {
  const { now } = input;
  const reception = input.reception;
  const receptionActor = actorOf(reception.userId, 'reception');
  const system = systemOf(input.tenantId);

  await input.withTenant(system, async (tx) => {
    const agenda = await loadKnown(
      tx,
      input.appointments.map((item) => item.id),
    );
    // Only people the log can believably have written to: with an email address and a phone.
    const reachable = agenda.filter((item) => item.email !== null && item.phone !== null);
    const attended = reachable.filter((item) => item.status === 'attended').reverse();
    const upcoming = reachable.filter(
      (item) =>
        item.startsAt.getTime() > now.getTime() &&
        (item.status === 'scheduled' || item.status === 'confirmed'),
    );
    const confirmed = upcoming.find((item) => item.status === 'confirmed');
    const others = upcoming.filter((item) => item.id !== confirmed?.id);

    // The people behind the story, one role each, never the same patient twice.
    const used = new Set<string>();
    const pick = (list: readonly Known[], skip = 0): Known | undefined => {
      const found = list.filter((item) => !used.has(item.patientId))[skip];
      if (found) used.add(found.patientId);
      return found;
    };
    const readWhatsapp = pick(attended);
    const refusedWhatsapp = pick(attended);
    const plainEmail = pick(attended);
    const replied = confirmed && !used.has(confirmed.patientId) ? confirmed : pick(upcoming);
    if (replied) used.add(replied.patientId);
    const waiting = pick(others);
    const emailOptOut = pick(others);
    const demoCancelled = pick(others);
    const whatsappOptOut = pick(others);

    // 1. What the patients chose. Opt-ins are recorded by the patient or by reception; an opt-out
    // is the patient's own word (a keyword on WhatsApp, the link of an email) and it is for every
    // channel (owner decision B7), so both patients end up with "Sin avisos".
    for (const entry of [readWhatsapp, refusedWhatsapp, replied, whatsappOptOut]) {
      if (!entry) continue;
      await recordOptIn(tx, {
        patientId: entry.patientId,
        channel: 'whatsapp',
        source: entry === refusedWhatsapp ? 'staff' : 'patient_email_link',
        recordedBy: entry === refusedWhatsapp ? reception.userId : undefined,
        actor: entry === refusedWhatsapp ? receptionActor : anonymous(),
      });
    }
    if (whatsappOptOut) {
      await optOutPatient(tx, {
        patientId: whatsappOptOut.patientId,
        source: 'whatsapp_keyword',
        actor: anonymous(),
      });
    }
    if (emailOptOut) {
      await optOutPatient(tx, {
        patientId: emailOptOut.patientId,
        source: 'email_link',
        actor: anonymous(),
      });
    }

    // 2. The messages.
    const rows: (Row | undefined)[] = [];
    const reminderOf = (
      item: Known,
      channel: MessageChannel,
      status: MessageStatus,
      extra: Partial<Row> = {},
    ): Row => ({
      kind: 'reminder',
      channel,
      status,
      patientId: item.patientId,
      appointmentId: item.id,
      professionalId: item.professionalId,
      plannedStartsAt: item.startsAt,
      appointmentVersion: item.version,
      // Due a day before the visit, and never later than a couple of hours ago: the log shows what
      // already happened.
      sendAt: new Date(Math.min(item.startsAt.getTime() - 24 * HOUR, now.getTime() - 2 * HOUR)),
      address: channel === 'email' ? lower(item.email) : whatsappNumber(item.phone),
      group: `reminder:${item.id}:24`,
      ...extra,
    });

    rows.push(
      // A reminder on WhatsApp that the patient read.
      readWhatsapp &&
        reminderOf(readWhatsapp, 'whatsapp', 'read', { events: ['sent', 'delivered', 'read'] }),
      // One WhatsApp refused for good (the number is not on WhatsApp); email carried the reminder.
      refusedWhatsapp &&
        reminderOf(refusedWhatsapp, 'whatsapp', 'failed', {
          failureReason: 'not_on_whatsapp',
          events: ['failed'],
        }),
      refusedWhatsapp && reminderOf(refusedWhatsapp, 'email', 'sent'),
      // A plain email reminder, and the confirmation of another appointment.
      plainEmail && reminderOf(plainEmail, 'email', 'sent'),
      plainEmail && {
        ...reminderOf(plainEmail, 'email', 'sent'),
        kind: 'confirmation' as const,
        sendAt: new Date(now.getTime() - 5 * 24 * HOUR),
        group: `confirmation:${plainEmail.id}`,
      },
      // The patient who answered "1" to a WhatsApp reminder, delivered.
      replied && reminderOf(replied, 'whatsapp', 'delivered', { events: ['sent', 'delivered'] }),
      // Still waiting for its hour.
      waiting && {
        ...reminderOf(waiting, 'email', 'queued'),
        sendAt: new Date(
          Math.max(now.getTime() + 2 * HOUR, waiting.startsAt.getTime() - 24 * HOUR),
        ),
      },
      // The patient who stopped email: the reminder was cancelled, not sent.
      emailOptOut && reminderOf(emailOptOut, 'email', 'cancelled', { cancelReason: 'opted_out' }),
      // What a demonstration organization's worker does with a message that reaches it.
      demoCancelled &&
        reminderOf(demoCancelled, 'email', 'cancelled', { cancelReason: 'demo_tenant' }),
      // The patient who later wrote BAJA: the reminder before it was delivered.
      whatsappOptOut &&
        reminderOf(whatsappOptOut, 'whatsapp', 'delivered', {
          events: ['sent', 'delivered'],
          sendAt: new Date(now.getTime() - 3 * 24 * HOUR),
          group: `reminder:${whatsappOptOut.id}:48`,
        }),
    );

    // The confirmations of the online bookings, by email to the address the visitor verified.
    const booked = await loadKnown(
      tx,
      sources.onlineBooking.bookings.map((booking) => booking.appointmentId),
    );
    for (const item of booked) {
      const booking = sources.onlineBooking.bookings.find(
        (entry) => entry.appointmentId === item.id,
      );
      if (booking?.status !== 'scheduled') continue;
      rows.push({
        ...reminderOf(item, 'email', 'sent'),
        kind: 'confirmation',
        sendAt: new Date(now.getTime() - 6 * HOUR),
        group: `confirmation:${item.id}`,
      });
    }

    // The virtual appointments: the reminder with its link, the reminder that promised it, and the
    // message that kept the promise.
    const visits = await loadKnown(
      tx,
      sources.teleconsultation.visits.map((visit) => visit.appointmentId),
    );
    const visitOf = (position: number) => {
      const planned = sources.teleconsultation.visits[position];
      return planned ? visits.find((item) => item.id === planned.appointmentId) : undefined;
    };
    const withLink = visitOf(0);
    const stillPending = visitOf(2);
    const followedUp = visitOf(3);
    rows.push(
      withLink && {
        ...reminderOf(withLink, 'email', 'sent'),
        sendAt: new Date(now.getTime() - 2 * HOUR),
      },
      // The link could not be made: the reminder said it would follow, and it has not yet.
      stillPending && {
        ...reminderOf(stillPending, 'email', 'sent'),
        sendAt: new Date(now.getTime() - 2 * HOUR),
        videoPending: true,
      },
      // The link appeared after the reminder: this is the message that carries it.
      followedUp && {
        ...reminderOf(followedUp, 'email', 'sent'),
        sendAt: new Date(now.getTime() - 3 * HOUR),
        videoPending: true,
      },
      followedUp && {
        ...reminderOf(followedUp, 'email', 'sent'),
        kind: 'video_link' as const,
        sendAt: new Date(now.getTime() - 90 * 60_000),
        group: `video_link:${followedUp.id}:${String(followedUp.version)}`,
      },
    );

    // The offer of the waitlist that is open.
    const offer = sources.waitlist.openOffer;
    const offerRow = offer
      ? await tx
          .select({
            patientId: waitlistOffer.patientId,
            professionalId: waitlistOffer.professionalId,
            startsAt: waitlistOffer.startsAt,
            endsAt: waitlistOffer.endsAt,
            expiresAt: waitlistOffer.expiresAt,
            locationId: waitlistOffer.locationId,
          })
          .from(waitlistOffer)
          .where(eq(waitlistOffer.id, offer.id))
      : [];

    // The WhatsApp numbers hashed below are those of the patients; nothing else is kept.
    const written: { id: string; row: Row }[] = [];
    let counter = 0;
    for (const row of rows) {
      if (!row) continue;
      counter += 1;
      const accepted = row.status === 'sent' || row.status === 'delivered' || row.status === 'read';
      const sentAt = accepted ? new Date(row.sendAt.getTime() + 4_000) : null;
      const deliveredAt =
        row.status === 'delivered' || row.status === 'read'
          ? new Date(row.sendAt.getTime() + 9_000)
          : null;
      const readAt = row.status === 'read' ? new Date(row.sendAt.getTime() + 3 * 60_000) : null;
      const inserted = await tx
        .insert(message)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          kind: row.kind,
          channel: row.channel,
          status: row.status,
          patientId: row.patientId,
          appointmentId: row.appointmentId,
          professionalId: row.professionalId,
          cancelReason: row.cancelReason ?? null,
          failureReason: row.failureReason ?? null,
          // A provider id names one message of one organization on the whole platform.
          providerMessageId:
            row.channel === 'whatsapp' && row.status !== 'cancelled'
              ? `demo-wa-${input.tenantId}-${String(counter)}`
              : null,
          dedupeKey: `${row.group}:${row.channel}`,
          addressHash: row.address === null ? null : hashAddress(row.channel, row.address),
          plannedStartsAt: row.plannedStartsAt,
          appointmentVersion: row.appointmentVersion,
          sendAt: row.sendAt,
          sentAt,
          deliveredAt,
          readAt,
          attempts: accepted || row.status === 'failed' ? 1 : 0,
          videoPending: row.videoPending ?? false,
          createdAt: new Date(row.sendAt.getTime() - 60_000),
        })
        .returning({ id: message.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error('A demo message was not written.');
      written.push({ id, row });

      if (accepted || row.status === 'failed') {
        await tx.insert(messageAttempt).values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          messageId: id,
          attemptNo: 1,
          outcome: accepted ? 'accepted' : 'rejected',
          reason: accepted ? null : (row.failureReason ?? null),
        });
      }
      for (const status of row.events ?? []) {
        await tx.insert(messageEvent).values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          eventId: `demo-evt-${String(counter)}-${status}`,
          messageId: id,
          status,
        });
      }
      // The provider took a WhatsApp message: it counted against its professional, once.
      if (row.channel === 'whatsapp' && accepted && row.professionalId !== null) {
        await tx.insert(whatsappUsageEvent).values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          messageId: id,
          professionalId: row.professionalId,
          countedAt: sentAt ?? row.sendAt,
          period: periodOf(sentAt ?? row.sendAt),
        });
      }
    }

    // The offer message, and the offer that now says by which channel it went.
    const [shown] = offerRow;
    if (offer && shown) {
      const target = await tx
        .select({ email: patient.email })
        .from(patient)
        .where(eq(patient.id, shown.patientId));
      const sendAt = new Date(now.getTime() - 20 * 60_000);
      const [created] = await tx
        .insert(message)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          kind: 'waitlist_offer',
          channel: 'email',
          status: 'sent',
          patientId: shown.patientId,
          appointmentId: null,
          professionalId: shown.professionalId,
          dedupeKey: `waitlist_offer:${offer.id}:email`,
          addressHash: target[0]?.email ? hashAddress('email', target[0].email) : null,
          plannedStartsAt: shown.startsAt,
          appointmentVersion: null,
          sendAt,
          sentAt: new Date(sendAt.getTime() + 4_000),
          attempts: 1,
          createdAt: new Date(sendAt.getTime() - 60_000),
        })
        .returning({ id: message.id });
      if (created) {
        await tx.insert(messageAttempt).values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          messageId: created.id,
          attemptNo: 1,
          outcome: 'accepted',
        });
        // The link is the one thing the log never keeps: the row stays, the address is empty.
        await tx.insert(messageOffer).values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          messageId: created.id,
          offerId: offer.id,
          locationId: shown.locationId,
          startsAt: shown.startsAt,
          endsAt: shown.endsAt,
          expiresAt: shown.expiresAt,
          url: null,
        });
        await tx
          .update(waitlistOffer)
          .set({
            channel: 'email',
            deliveredAt: new Date(sendAt.getTime() + 4_000),
            messageId: created.id,
          })
          .where(and(eq(waitlistOffer.id, offer.id), eq(waitlistOffer.status, 'open')));
      }
    }

    // 3. The replies that reached the organization: a confirmation, and the word that stops WhatsApp.
    const replies = [
      replied && {
        key: 'confirmed',
        outcome: 'confirmed' as const,
        from: whatsappNumber(replied.phone),
      },
      whatsappOptOut && {
        key: 'opted-out',
        outcome: 'opted_out' as const,
        from: whatsappNumber(whatsappOptOut.phone),
      },
    ];
    for (const reply of replies) {
      if (!reply?.from) continue;
      await tx.insert(inboundMessage).values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        eventId: `demo-in-${reply.key}`,
        fromHash: hashAddress('whatsapp', reply.from),
        outcome: reply.outcome,
      });
    }
  });
}
