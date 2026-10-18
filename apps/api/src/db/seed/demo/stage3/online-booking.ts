import { createHash } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';

import { recordOptIn } from '../../../../modules/notifications/application/preferences.js';
import { createLinkService } from '../../../../modules/online-booking/application/links.js';
import { identityDifferences } from '../../../../modules/online-booking/domain/identity-differences.js';
import { createOnlinePatient, findPatientByDocument } from '../../../../modules/patients/index.js';
import type { SchedulingPorts } from '../../../../modules/scheduling/application/ports.js';
import { createWorklistService } from '../../../../modules/scheduling/application/worklist.js';
import { audit } from '../../../../platform/audit/writer.js';
import { appointmentType } from '../../../schema/scheduling-config.js';
import { tenant } from '../../../schema/tenant.js';

import {
  actorOf,
  anonymous,
  bookFirstFree,
  bookerOf,
  candidateSlots,
  claim,
  type Stage3Context,
} from './shared.js';
import { VIRTUAL_TYPE_NAME } from './teleconsultation.js';

/**
 * The public booking of the demo (tasks 3.72): every professional has an enabled link and the
 * organization has its own, each with a stable address that a QR code can carry. Three bookings made
 * through them are in the agenda, written the way the online flow writes them: one confirmed for a
 * person who registered themselves, one that waits for reception to approve it, and one made with the
 * document of a patient who already exists, whose identity reception has to review (decision D14).
 *
 * The bookings are written directly: the real flow needs a visitor, a code in a mailbox and a bot
 * challenge, and a demonstration organization keeps no unverified form. What a visitor typed is not
 * kept either, so there are no submissions here.
 */

const TYPES_OF = {
  cardiology: ['Primera consulta', 'Control', 'Chequeo cardiológico', VIRTUAL_TYPE_NAME],
  pediatrics: ['Primera consulta', 'Control de niño sano', 'Control', VIRTUAL_TYPE_NAME],
  psychology: ['Sesión de terapia', VIRTUAL_TYPE_NAME],
} as const;

type ProfessionalKey = keyof typeof TYPES_OF;
const PROFESSIONAL_KEYS = Object.keys(TYPES_OF) as ProfessionalKey[];

export interface SeededOnlineBooking {
  appointmentId: string;
  patientId: string;
  professionalId: string;
  startsAt: Date;
  status: 'scheduled' | 'pending_approval';
  identityConfirmed: boolean;
}

export interface OnlineBookingSeed {
  /** The path of each link, ready for a QR code: the organization first. */
  linkPaths: string[];
  bookings: SeededOnlineBooking[];
  /** The patients who registered themselves online, with a number WhatsApp could reach. */
  onlinePatients: { id: string; whatsapp: boolean }[];
}

interface PlannedBooking {
  professional: ProfessionalKey;
  type: string;
  /** A person who registers themselves, or the document of a patient who already exists. */
  visitor:
    | {
        kind: 'new';
        givenNames: string;
        familyName: string;
        birthDate: string;
        document: string;
        phone: string;
        email: string;
        whatsapp: boolean;
      }
    | {
        kind: 'existing';
        document: string;
        typed: { phone: string; email: string; familyName: string };
      };
  status: 'scheduled' | 'pending_approval';
}

const PLAN: readonly PlannedBooking[] = [
  {
    professional: 'cardiology',
    type: 'Primera consulta',
    visitor: {
      kind: 'new',
      givenNames: 'Julieta',
      familyName: 'Ferrari',
      birthDate: '1991-04-12',
      document: '99100001',
      phone: '+5491155500101',
      email: 'julieta.ferrari@demo.invalid',
      whatsapp: true,
    },
    status: 'scheduled',
  },
  {
    professional: 'psychology',
    type: 'Sesión de terapia',
    visitor: {
      kind: 'new',
      givenNames: 'Matías',
      familyName: 'Sosa',
      birthDate: '1984-09-03',
      document: '99100002',
      phone: '+5491155500102',
      email: 'matias.sosa@demo.invalid',
      whatsapp: false,
    },
    status: 'pending_approval',
  },
  {
    professional: 'cardiology',
    type: 'Control',
    visitor: {
      kind: 'existing',
      document: '99000004',
      // The visitor wrote a new phone, another email and a different spelling of the surname.
      typed: {
        phone: '+5491155500103',
        email: 'nuevo.correo@demo.invalid',
        familyName: 'López Peña',
      },
    },
    status: 'scheduled',
  },
];

/** The people the bookings register: the patient count of a demonstration organization grows by it. */
export const ONLINE_PATIENTS = PLAN.filter((entry) => entry.visitor.kind === 'new').length;

/** The same bytes for the same organization and link, so the address survives a reset. */
function stableBytes(tenantSlug: string, label: string): Uint8Array {
  return createHash('sha256').update(`booking-link:${tenantSlug}:${label}`).digest();
}

/** An online booking is written as the public flow writes it: one lane, nobody as the booker. */
function onlinePorts(
  ports: SchedulingPorts,
  options: { status: 'scheduled' | 'pending_approval'; identityConfirmed: boolean },
): SchedulingPorts {
  const single = <T extends { maxSimultaneous: number }>(record: T | null) =>
    record ? { ...record, maxSimultaneous: 1 } : null;
  return {
    ...ports,
    lockProfessional: async (id) => single(await ports.lockProfessional(id)),
    findProfessional: async (id) => single(await ports.findProfessional(id)),
    occupancies: async (professionalId, range) =>
      (await ports.occupancies(professionalId, range)).map((entry) => ({ ...entry, lane: 1 })),
    isFreshPatient: () => Promise.resolve(false),
    insertAppointment: (values) =>
      ports.insertAppointment({
        ...values,
        status: options.status,
        source: 'online',
        bookedBy: null,
        identityConfirmed: options.identityConfirmed,
      }),
    // The review and the approval items carry detail the caller knows: it opens them.
    openWorklistItem: () => Promise.resolve(),
    insertEvent: (event) =>
      ports.insertEvent({
        ...event,
        actorUserId: null,
        actorKind: 'patient',
        details: { ...event.details, source: 'online' },
      }),
    audit: (event) =>
      ports.audit(
        event.action === 'appointment.created'
          ? {
              ...event,
              metadata: {
                ...event.metadata,
                identityConfirmed: options.identityConfirmed,
                source: 'online',
                channel: 'email',
              },
            }
          : event,
      ),
  };
}

export async function seedOnlineBooking(
  input: Stage3Context,
  taken: Set<string>,
): Promise<OnlineBookingSeed> {
  const owner = input.people.get('owner');
  const reception = input.reception;
  if (!owner) throw new Error('The dataset needs an owner.');
  const ownerActor = { ...actorOf(owner.userId, 'owner'), userId: owner.userId };
  const worklist = createWorklistService({ keys: input.keys });

  // 1. The links, as the owner.
  const linkPaths: string[] = [];
  await input.withTenant({ tenantId: input.tenantId, userId: owner.userId }, async (tx) => {
    const [org] = await tx
      .select({ slug: tenant.slug })
      .from(tenant)
      .where(eq(tenant.id, input.tenantId));
    const labels = ['organization', ...PROFESSIONAL_KEYS];
    let drawn = 0;
    const links = createLinkService({
      randomBytes: () => {
        const label = labels[drawn] ?? `again-${String(drawn)}`;
        drawn += 1;
        return stableBytes(org?.slug ?? 'demo', label);
      },
    });
    const organizationLink = await links.create(tx, {
      actor: ownerActor,
      request: { enabled: true },
    });
    if (organizationLink.path) linkPaths.push(organizationLink.path);

    const types = await tx
      .select({ id: appointmentType.id, name: appointmentType.name })
      .from(appointmentType)
      .where(inArray(appointmentType.name, [...new Set(Object.values(TYPES_OF).flat())]));
    const typeId = new Map(types.map((type) => [type.name, type.id]));
    for (const key of PROFESSIONAL_KEYS) {
      const professionalId = input.professionalIds.get(key);
      if (!professionalId) continue;
      const ids = TYPES_OF[key].flatMap((name) => {
        const found = typeId.get(name);
        return found ? [found] : [];
      });
      const link = await links.create(tx, {
        actor: ownerActor,
        request: { professionalId, enabled: true, typeIds: ids, locationIds: [] },
      });
      if (link.path) linkPaths.push(link.path);
    }
  });

  // 2. The bookings, the way a visitor leaves them.
  const bookings: SeededOnlineBooking[] = [];
  const onlinePatients: OnlineBookingSeed['onlinePatients'] = [];
  const system = { tenantId: input.tenantId, userId: reception.userId };
  const types = await input.withTenant(system, (tx) =>
    tx.select({ id: appointmentType.id, name: appointmentType.name }).from(appointmentType),
  );
  const typeByName = (name: string) => {
    const found = types.find((type) => type.name === name)?.id;
    if (!found) throw new Error(`The demo has no appointment type "${name}".`);
    return found;
  };

  for (const [index, entry] of PLAN.entries()) {
    const professionalId = input.professionalIds.get(entry.professional);
    if (!professionalId) continue;
    const booking = await input.withTenant(system, async (tx) => {
      const candidates = await candidateSlots(tx, {
        professionalId,
        now: input.now,
        taken,
        count: 6,
        firstWeek: 5 + index,
      });
      let patientId: string;
      let identityConfirmed = true;
      let differences: ReturnType<typeof identityDifferences> = [];
      let createdPatient = false;
      if (entry.visitor.kind === 'new') {
        const visitor = entry.visitor;
        patientId = (
          await createOnlinePatient(tx, {
            actor: anonymous(),
            givenNames: visitor.givenNames,
            familyName: visitor.familyName,
            birthDate: visitor.birthDate,
            document: { type: 'dni', number: visitor.document },
            phone: visitor.phone,
            email: visitor.email,
            consent: { textKey: 'consent.data_processing', version: '1' },
          })
        ).id;
        createdPatient = true;
        if (visitor.whatsapp) {
          // What the visitor ticked on the form: recorded for a person the booking registered.
          await recordOptIn(tx, {
            patientId,
            channel: 'whatsapp',
            source: 'online_booking',
            actor: anonymous(),
          });
        }
        onlinePatients.push({ id: patientId, whatsapp: visitor.whatsapp });
      } else {
        const match = await findPatientByDocument(tx, {
          type: 'dni',
          number: entry.visitor.document,
        });
        if (!match) throw new Error('The demo patient of the identity review is missing.');
        patientId = match.id;
        identityConfirmed = false;
        differences = identityDifferences(match, {
          givenNames: match.givenNames,
          familyName: entry.visitor.typed.familyName,
          birthDate: match.birthDate,
          phone: entry.visitor.typed.phone,
          email: entry.visitor.typed.email,
        });
      }

      const booked = await bookFirstFree(tx, {
        keys: input.keys,
        now: input.now,
        patientId,
        professionalId,
        appointmentTypeId: typeByName(entry.type),
        candidates,
        actor: bookerOf(reception.userId),
        auditActor: actorOf(reception.userId, 'reception'),
        through: (ports) => onlinePorts(ports, { status: entry.status, identityConfirmed }),
      });
      claim(taken, professionalId, booked.slot);
      const appointmentId = booked.appointment.id;

      if (!identityConfirmed) {
        await worklist.openItem(tx, {
          kind: 'identity_review',
          subjectType: 'appointment',
          subjectId: appointmentId,
          locationId: booked.slot.locationId,
          detail: { source: 'online_booking', differences, whatsappOptInRequested: false },
        });
      }
      if (entry.status === 'pending_approval') {
        await worklist.openItem(tx, {
          kind: 'pending_approval',
          subjectType: 'appointment',
          subjectId: appointmentId,
          locationId: booked.slot.locationId,
        });
      }
      await audit(tx, {
        action: 'booking.online.created',
        outcome: 'allow',
        actor: anonymous(),
        resourceType: 'appointment',
        resourceId: appointmentId,
        patientId,
        metadata: {
          channel: 'email',
          pendingApproval: entry.status === 'pending_approval',
          newPatient: createdPatient,
        },
      });
      return {
        appointmentId,
        patientId,
        professionalId,
        startsAt: booked.slot.startsAt,
        status: entry.status,
        identityConfirmed,
      } satisfies SeededOnlineBooking;
    });
    bookings.push(booking);
  }
  return { linkPaths, bookings, onlinePatients };
}
