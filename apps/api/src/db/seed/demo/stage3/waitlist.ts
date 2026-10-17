import { CreateWaitlistEntryRequest, type WaitlistEntryDto } from '@consultorio/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { createSchedulingPorts } from '../../../../modules/scheduling/application/drizzle-ports.js';
import { createEntry, pauseEntry } from '../../../../modules/waitlist/application/entries.js';
import { expireOffer } from '../../../../modules/waitlist/application/expiry.js';
import { matchFreedSlot } from '../../../../modules/waitlist/application/match.js';
import type { Tx } from '../../../../platform/db/tenant-context.js';
import { patient } from '../../../schema/patients.js';
import { appointmentType } from '../../../schema/scheduling-config.js';
import { waitlistOffer } from '../../../schema/waitlist.js';

import {
  actorOf,
  candidateSlots,
  claim,
  noJobs,
  reachablePatients,
  type FreeSlot,
  type Stage3Context,
} from './shared.js';

/**
 * The waitlist of the demo (tasks 3.72). Patients wait for a cardiologist, a pediatrician and a
 * psychologist; freed times are put through the real matching, so what is left is what the product
 * itself would leave:
 *
 * - the first cardiology entry was offered a time that nobody answered (an expired offer) and now
 *   holds a second, open one;
 * - the second cardiology entry waits behind it;
 * - an entry whose patient cannot be reached, and one with no agreement to receive offers, are
 *   "manual contact only": the freed time is shown to reception to fill by phone;
 * - one entry is paused.
 *
 * The open offer lasts until two hours before its time, so the demo keeps showing it (a real one
 * lasts half an hour). Nothing is sent: the seed has no queue, and the message log of the demo says
 * the offer went by email.
 */

export interface WaitlistSeed {
  entries: WaitlistEntryDto[];
  /** The open offer, for the message log. */
  openOffer: { id: string; entryId: string; patientId: string; locationId: string } | null;
}

interface Planned {
  key: 'first' | 'second' | 'unreachable' | 'no_opt_in' | 'paused';
  professional: 'cardiology' | 'pediatrics' | 'psychology';
  type: string;
  offersOptIn: boolean;
  /** Preference of days and hours, in local time. */
  weekdays?: number[];
  timeRanges?: { from: string; to: string }[];
}

const PLAN: readonly Planned[] = [
  { key: 'first', professional: 'cardiology', type: 'Control', offersOptIn: true },
  {
    key: 'second',
    professional: 'cardiology',
    type: 'Control',
    offersOptIn: true,
    weekdays: [1, 2, 3, 4, 5],
    timeRanges: [{ from: '08:00', to: '13:00' }],
  },
  {
    key: 'unreachable',
    professional: 'pediatrics',
    type: 'Control de niño sano',
    offersOptIn: true,
  },
  { key: 'no_opt_in', professional: 'psychology', type: 'Sesión de terapia', offersOptIn: false },
  { key: 'paused', professional: 'cardiology', type: 'Chequeo cardiológico', offersOptIn: true },
];

/** A child whose record has no email and no phone: nobody to send an offer to. */
function childWithoutContact(tx: Tx) {
  return tx
    .select({ id: patient.id })
    .from(patient)
    .where(
      and(isNull(patient.email), isNull(patient.phone), sql`${patient.birthDate} > '2008-01-01'`),
    )
    .orderBy(patient.familyName, patient.givenNames)
    .limit(1);
}

export async function seedWaitlist(
  input: Stage3Context,
  taken: Set<string>,
): Promise<WaitlistSeed> {
  const reception = input.reception;
  const staff = { ...actorOf(reception.userId, 'reception'), userId: reception.userId };
  const context = { tenantId: input.tenantId, userId: reception.userId };
  const portsOf = (tx: Tx) => createSchedulingPorts(tx, { keys: input.keys });
  const deps = { portsOf, jobs: noJobs };

  const patients = await input.withTenant(context, (tx) => reachablePatients(tx, 20));
  const child = await input.withTenant(context, async (tx) => (await childWithoutContact(tx))[0]);
  const types = await input.withTenant(context, (tx) =>
    tx
      .select({ id: appointmentType.id, name: appointmentType.name })
      .from(appointmentType)
      .where(inArray(appointmentType.name, [...new Set(PLAN.map((entry) => entry.type))])),
  );
  const typeId = (name: string) => {
    const found = types.find((type) => type.name === name)?.id;
    if (!found) throw new Error(`The demo has no appointment type "${name}".`);
    return found;
  };

  // 1. The people who wait, in the order they joined (a minute apart).
  const entries = new Map<Planned['key'], WaitlistEntryDto>();
  for (const [index, planned] of PLAN.entries()) {
    const professionalId = input.professionalIds.get(planned.professional);
    const person =
      planned.key === 'unreachable' ? child : patients[(index * 3 + 1) % patients.length];
    if (!professionalId || !person) continue;
    const joinedAt = new Date(input.now.getTime() - (PLAN.length - index) * 3_600_000);
    const entry = await input.withTenant(context, async (tx) => {
      const created = await createEntry(
        tx,
        { portsOf },
        {
          request: CreateWaitlistEntryRequest.parse({
            patientId: person.id,
            appointmentTypeId: typeId(planned.type),
            professionalId,
            locationId: null,
            weekdays: planned.weekdays ?? [],
            timeRanges: planned.timeRanges ?? [],
            offersOptIn: planned.offersOptIn,
            channels: ['email'],
          }),
          actor: staff,
          now: joinedAt,
        },
      );
      if (planned.key === 'paused') {
        return pauseEntry(tx, { jobs: noJobs }, { id: created.id, actor: staff, now: input.now });
      }
      return created;
    });
    entries.set(planned.key, entry);
  }

  // 2. Freed times, through the real matching.
  const cardiologyId = input.professionalIds.get('cardiology');
  const freed = async (professionalKey: Planned['professional'], count: number) => {
    const professionalId = input.professionalIds.get(professionalKey);
    if (!professionalId) return [] as FreeSlot[];
    const slots = await input.withTenant(context, (tx) =>
      candidateSlots(tx, { professionalId, now: input.now, taken, count, firstWeek: 8 }),
    );
    for (const slot of slots) claim(taken, professionalId, slot);
    return slots;
  };
  const match = async (professionalId: string, slot: FreeSlot) =>
    input.withTenant(context, (tx) =>
      matchFreedSlot(tx, deps, {
        professionalId,
        locationId: slot.locationId,
        startsAt: slot.startsAt,
        endsAt: new Date(slot.startsAt.getTime() + 60 * 60_000),
        now: input.now,
      }),
    );

  if (cardiologyId) {
    const [earlier, later] = await freed('cardiology', 2);
    if (earlier && later) {
      // The first entry was offered a time and let it run out ...
      const missed = await match(cardiologyId, earlier);
      if (missed.offerId) {
        const offerId = missed.offerId;
        await input.withTenant(context, async (tx) => {
          const [offer] = await tx
            .select({ expiresAt: waitlistOffer.expiresAt })
            .from(waitlistOffer)
            .where(eq(waitlistOffer.id, offerId));
          if (offer) await expireOffer(tx, { jobs: noJobs }, { offerId, now: offer.expiresAt });
        });
      }
      // ... and holds a second one, which is open.
      await match(cardiologyId, later);
    }
  }
  for (const key of ['pediatrics', 'psychology'] as const) {
    const professionalId = input.professionalIds.get(key);
    const [slot] = await freed(key, 1);
    if (professionalId && slot) await match(professionalId, slot);
  }

  // 3. The open offer lasts as long as the demo does.
  const open = await input.withTenant(context, async (tx) => {
    await tx
      .update(waitlistOffer)
      .set({ expiresAt: sql`${waitlistOffer.startsAt} - interval '2 hours'` })
      .where(eq(waitlistOffer.status, 'open'));
    const [offer] = await tx
      .select({
        id: waitlistOffer.id,
        entryId: waitlistOffer.entryId,
        patientId: waitlistOffer.patientId,
        locationId: waitlistOffer.locationId,
      })
      .from(waitlistOffer)
      .where(eq(waitlistOffer.status, 'open'));
    return offer ?? null;
  });

  return { entries: [...entries.values()], openOffer: open };
}
