import { and, eq } from 'drizzle-orm';

import {
  waitlistEntry,
  waitlistOffer,
  type WaitlistEntryRow,
  type WaitlistOfferRow,
} from '../../../db/schema/waitlist.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type {
  TokenContext,
  TokenHandler,
  TokenPage,
} from '../../../platform/public/token-router.js';
import type { SchedulingPorts } from '../../scheduling/index.js';
import { closeEntryRow } from '../application/entries.js';
import { expireOffer } from '../application/expiry.js';
import { lockOffer } from '../application/offer-lock.js';
import { SYSTEM_ACTOR } from '../application/offers.js';
import { bookSlot } from '../application/slot-booking.js';
import { loadSlotNames, type SlotNames } from '../application/slot-names.js';
import { enqueueRematch } from '../application/trigger.js';
import { dateText, timeText } from '../domain/format.js';

export interface OfferHandlerDeps {
  /** Scheduling's view of the organization, for the booking an acceptance makes. */
  portsOf(tx: Tx): SchedulingPorts;
  /** Enqueues the match for the next entry when an offer is declined. Absent: nothing is matched. */
  jobs: JobClient | undefined;
}

const STAYS_ON_THE_LIST = 'Sigue en la lista de espera: si se libera otro turno, le avisaremos.';

/** What the page shows of a slot: date, time, place and, per the organization, the professional. */
function slotRows(offer: WaitlistOfferRow, names: SlotNames) {
  return [
    { label: 'Fecha', value: dateText(offer.startsAt, names.timeZone) },
    { label: 'Hora', value: timeText(offer.startsAt, names.timeZone) },
    { label: 'Lugar', value: names.locationName },
    ...(names.professionalName === null
      ? []
      : [{ label: 'Profesional', value: names.professionalName }]),
  ];
}

interface Found {
  offer: WaitlistOfferRow;
  entry: WaitlistEntryRow;
  names: SlotNames;
}

/** The offer the link is about, with its entry and the words for its slot. */
async function load(
  tx: Tx,
  context: TokenContext,
  options: { ports: SchedulingPorts | null },
): Promise<Found | null> {
  // To answer, the offer is locked the way a booking would (the professional first); to look, not.
  const offer = options.ports
    ? await lockOffer(tx, options.ports, context.subjectId)
    : (await tx.select().from(waitlistOffer).where(eq(waitlistOffer.id, context.subjectId)))[0];
  if (!offer) return null;
  // The link was issued for this entry's offer: any other pairing is a link that was not made for it.
  if (context.payload['entryId'] !== offer.entryId) return null;
  const entryQuery = tx.select().from(waitlistEntry).where(eq(waitlistEntry.id, offer.entryId));
  const [entry] = await (options.ports ? entryQuery.for('update') : entryQuery);
  if (!entry) return null;
  const names = await loadSlotNames(tx, offer);
  if (!names) return null;
  return { offer, entry, names };
}

/** The page of an offer that can no longer be answered, or null while it can. */
function overPage(found: Found, now: Date): TokenPage | null {
  const { offer, names } = found;
  switch (offer.status) {
    case 'accepted':
      return {
        title: 'Ya aceptó este turno',
        details: slotRows(offer, names),
        message: 'Lo esperamos.',
      };
    case 'declined':
      return { title: 'Ya rechazó esta oferta', message: STAYS_ON_THE_LIST };
    case 'expired':
      return { title: 'La oferta venció', message: STAYS_ON_THE_LIST };
    case 'invalidated':
      return { title: 'El turno ya no está disponible', message: STAYS_ON_THE_LIST };
    case 'open':
      return offer.expiresAt.getTime() <= now.getTime()
        ? { title: 'La oferta venció', message: STAYS_ON_THE_LIST }
        : null;
    default:
      return null;
  }
}

function offerPage(found: Found): TokenPage {
  const { offer, names } = found;
  return {
    title: 'Hay un turno disponible',
    details: slotRows(offer, names),
    message: `Esta oferta vale hasta las ${timeText(offer.expiresAt, names.timeZone)}. Si no la acepta, ${STAYS_ON_THE_LIST.charAt(0).toLowerCase()}${STAYS_ON_THE_LIST.slice(1)}`,
    action: { label: 'Aceptar el turno', value: 'accept' },
    secondaryAction: { label: 'No me sirve', value: 'decline' },
  };
}

/**
 * The page behind the link of an offer (waitlist, "Offers with expiry"; design 4.5, kind
 * `waitlist_offer`). Looking at it shows the slot and two buttons and spends nothing. Pressing a
 * button spends the link and does one of two things:
 *
 * - accept: books the slot for the entry's patient through scheduling (a public flow: capacity
 *   one, source `waitlist_offer`, identity unconfirmed when a self-join attached the entry to an
 *   existing patient), closes the entry as fulfilled, and says so. If the booking is refused the
 *   offer is closed and the patient is told, and stays on the list.
 * - decline: the patient stays on the list and the slot goes to the next entry.
 *
 * An offer whose time ran out, or whose slot was taken, is not acted on; the page says so.
 */
export function createOfferHandler(deps: OfferHandlerDeps): TokenHandler {
  async function decline(tx: Tx, context: TokenContext, found: Found): Promise<TokenPage> {
    const { offer, entry } = found;
    await tx
      .update(waitlistOffer)
      .set({ status: 'declined', closedAt: context.now })
      .where(eq(waitlistOffer.id, offer.id));
    await tx
      .update(waitlistEntry)
      .set({ status: 'active', consecutiveExpired: 0, flaggedAt: null })
      .where(and(eq(waitlistEntry.id, entry.id), eq(waitlistEntry.status, 'offered')));
    await audit(tx, {
      action: 'waitlist.offer.declined',
      outcome: 'allow',
      actor: context.actor,
      resourceType: 'waitlist_offer',
      resourceId: offer.id,
      patientId: offer.patientId,
      metadata: { entryId: entry.id },
    });
    await enqueueRematch(tx, deps.jobs, [offer]);
    return { title: 'Gracias por avisarnos', message: STAYS_ON_THE_LIST };
  }

  async function accept(tx: Tx, context: TokenContext, found: Found): Promise<TokenPage> {
    const { offer, entry, names } = found;
    if (entry.status !== 'offered') {
      return { title: 'El turno ya no está disponible', message: STAYS_ON_THE_LIST, status: 409 };
    }
    // The offer is answered before the booking is made: the booking publishes that time was taken,
    // and the waitlist ends the open offers for taken time. This one must not be among them.
    await tx
      .update(waitlistOffer)
      .set({ status: 'accepted', closedAt: context.now })
      .where(eq(waitlistOffer.id, offer.id));
    const booking = await bookSlot(deps.portsOf(tx), {
      patientId: offer.patientId,
      professionalId: offer.professionalId,
      locationId: offer.locationId,
      appointmentTypeId: offer.appointmentTypeId,
      startsAt: offer.startsAt,
      identityConfirmed: !entry.identityUnconfirmed,
      auditActor: context.actor,
      now: context.now,
    });
    if (!booking.ok) {
      await tx
        .update(waitlistOffer)
        .set({ status: 'invalidated', endReason: booking.reason })
        .where(eq(waitlistOffer.id, offer.id));
      await tx
        .update(waitlistEntry)
        .set({ status: 'active' })
        .where(eq(waitlistEntry.id, entry.id));
      return { title: 'El turno ya no está disponible', message: STAYS_ON_THE_LIST, status: 409 };
    }

    await tx
      .update(waitlistOffer)
      .set({ appointmentId: booking.appointment.id })
      .where(eq(waitlistOffer.id, offer.id));
    await audit(tx, {
      action: 'waitlist.offer.accepted',
      outcome: 'allow',
      actor: context.actor,
      resourceType: 'waitlist_offer',
      resourceId: offer.id,
      patientId: offer.patientId,
      metadata: {
        entryId: entry.id,
        appointmentId: booking.appointment.id,
        channel: offer.channel ?? 'none',
        answeredAfterSeconds: Math.round(
          (context.now.getTime() - offer.createdAt.getTime()) / 1000,
        ),
      },
    });
    await closeEntryRow(tx, entry, { reason: 'fulfilled', actor: SYSTEM_ACTOR, now: context.now });
    return {
      title: 'Turno confirmado',
      details: slotRows(offer, names),
      message: 'Gracias. Lo esperamos.',
    };
  }

  return {
    allowedWhenReadOnly: false,
    audits: [
      'waitlist.offer.accepted',
      'waitlist.offer.declined',
      'waitlist.offer.expired',
      'waitlist.entry.closed',
      'appointment.created',
    ],
    async describe(context) {
      const found = await load(context.tx, context, { ports: null });
      if (!found) return null;
      return overPage(found, context.now) ?? offerPage(found);
    },
    async perform(context) {
      const { tx } = context;
      const found = await load(tx, context, { ports: deps.portsOf(tx) });
      if (!found) return null;

      const over = overPage(found, context.now);
      if (over) {
        // An offer past its time is closed here too, so the next entry does not wait for the sweep.
        if (found.offer.status === 'open' && deps.jobs) {
          await expireOffer(tx, { jobs: deps.jobs }, { offerId: found.offer.id, now: context.now });
        }
        return { ...over, status: 409 };
      }
      if (context.choice !== 'accept' && context.choice !== 'decline') return offerPage(found);
      if (!(await context.redeem())) return null;
      return context.choice === 'accept' ? accept(tx, context, found) : decline(tx, context, found);
    },
  };
}
