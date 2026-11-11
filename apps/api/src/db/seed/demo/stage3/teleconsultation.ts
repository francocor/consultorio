import { eq } from 'drizzle-orm';

import { createAppointmentTypeService } from '../../../../modules/scheduling/application/appointment-types.js';
import { newOpaqueRoomId } from '../../../../modules/teleconsultation/application/ports.js';
import { auditLinkEvent } from '../../../../modules/teleconsultation/application/video-audit.js';
import { appointment } from '../../../schema/scheduling.js';
import { videoSession } from '../../../schema/teleconsultation.js';

import {
  actorOf,
  bookFirstFree,
  bookerOf,
  candidateSlots,
  claim,
  reachablePatients,
  type Stage3Context,
} from './shared.js';

/**
 * The virtual appointments of the demo (tasks 3.72). A video visit type exists, offered by every
 * professional, and the agenda holds a few visits of that type three weeks out and later: most have
 * their link ready (a room of the fake provider, whose address is a static one that goes nowhere),
 * and one shows the alert reception sees when the provider could not make the room, so that the
 * manual link dialog has something to do. Nothing here calls a provider.
 */

export const VIRTUAL_TYPE_NAME = 'Consulta por videollamada';

export interface SeededVirtual {
  appointmentId: string;
  patientId: string;
  professionalId: string;
  professionalKey: string;
  startsAt: Date;
  locationId: string;
  /** `ready` has a link; `link_pending` is the one waiting for a manual link. */
  link: 'ready' | 'link_pending';
}

export interface TeleconsultationSeed {
  virtualTypeId: string;
  visits: SeededVirtual[];
}

/** Who has a video visit, in which order, and whether its link exists. */
const PLAN: readonly {
  professional: 'cardiology' | 'pediatrics' | 'psychology';
  link: SeededVirtual['link'];
}[] = [
  { professional: 'cardiology', link: 'ready' },
  { professional: 'psychology', link: 'ready' },
  { professional: 'cardiology', link: 'link_pending' },
  { professional: 'pediatrics', link: 'ready' },
];

export async function seedTeleconsultation(
  input: Stage3Context,
  taken: Set<string>,
): Promise<TeleconsultationSeed> {
  const owner = input.people.get('owner');
  const reception = input.reception;
  if (!owner) throw new Error('The dataset needs an owner.');
  const ownerActor = { ...actorOf(owner.userId, 'owner'), userId: owner.userId };

  const virtualTypeId = await input.withTenant(
    { tenantId: input.tenantId, userId: owner.userId },
    async (tx) => {
      const created = await createAppointmentTypeService().create(tx, {
        actor: ownerActor,
        request: {
          name: VIRTUAL_TYPE_NAME,
          durationMinutes: 30,
          bufferMinutes: 0,
          mode: 'virtual',
          requiresApproval: false,
          color: '#0369A1',
          professionalIds: [],
          specialties: [],
        },
      });
      return created.id;
    },
  );

  const visits: SeededVirtual[] = [];
  const patients = await input.withTenant(
    { tenantId: input.tenantId, userId: reception.userId },
    (tx) => reachablePatients(tx, 12),
  );
  for (const [index, entry] of PLAN.entries()) {
    const professionalId = input.professionalIds.get(entry.professional);
    const person = input.people.get(entry.professional);
    // Spread over different patients, away from the first ones the agenda already uses.
    const patient = patients[(index * 2 + 5) % patients.length];
    if (!professionalId || !person || !patient) continue;

    const visit = await input.withTenant(
      { tenantId: input.tenantId, userId: reception.userId },
      async (tx) => {
        const candidates = await candidateSlots(tx, {
          professionalId,
          now: input.now,
          taken,
          count: 6,
          firstWeek: 4,
        });
        const booked = await bookFirstFree(tx, {
          keys: input.keys,
          now: input.now,
          patientId: patient.id,
          professionalId,
          appointmentTypeId: virtualTypeId,
          candidates,
          actor: bookerOf(reception.userId),
          auditActor: actorOf(reception.userId, 'reception'),
        });
        claim(taken, professionalId, booked.slot);
        const appointmentId = booked.appointment.id;
        if (entry.link === 'ready') {
          await tx
            .update(appointment)
            .set({ videoRoom: newOpaqueRoomId() })
            .where(eq(appointment.id, appointmentId));
          await tx.insert(videoSession).values({
            tenantId: input.tenantId,
            appointmentId,
            status: 'ready',
            provider: 'fake',
          });
          await auditLinkEvent(tx, {
            action: 'video.link.created',
            appointmentId,
            actor: actorOf(reception.userId, 'reception'),
            metadata: { provider: 'fake' },
          });
        } else {
          // The provider could not make the room after its retries: reception sees the alert.
          await tx.insert(videoSession).values({
            tenantId: input.tenantId,
            appointmentId,
            status: 'link_pending',
            pendingReason: 'provider_failed',
          });
        }
        return {
          appointmentId,
          patientId: patient.id,
          professionalId,
          professionalKey: entry.professional,
          startsAt: booked.slot.startsAt,
          locationId: booked.slot.locationId,
          link: entry.link,
        } satisfies SeededVirtual;
      },
    );
    visits.push(visit);
  }
  return { virtualTypeId, visits };
}
