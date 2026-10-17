import type { AppointmentDto, PublicConfirmationDto } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { bookingSubmission } from '../../../db/schema/booking-submission.js';
import { audit } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { AppointmentFacts } from '../../../platform/events/appointment-events.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { createOnlinePatient, findPatientByDocument } from '../../patients/index.js';
import { SlotNoLongerAvailableError } from '../../scheduling/index.js';
import type { SchedulingPorts, WorklistService } from '../../scheduling/index.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { dailyCapReached } from '../domain/booking-rules.js';
import { identityDifferences } from '../domain/identity-differences.js';

import { ABUSE_LIMITS, bookingsInLastDay, futureOnlineAppointments, type Abuse } from './abuse.js';
import type { BookingNotice, BookingNotifier } from './booking-notifier.js';
import { readBookingSettings } from './booking-settings.js';
import { renderIcs } from './ics.js';
import { verifyCode } from './otp.js';
import { onlineBookingsOnDay } from './public-holds.js';
import {
  loadHold,
  SUBMISSION_FIELD,
  type SubmissionPayload,
  type SubmitInput,
} from './submissions.js';

export interface ConfirmDeps {
  keys: TenantKeys;
  worklist: WorklistService;
  tokens: ActionTokens;
  notifier: BookingNotifier;
  abuse: Abuse;
  portsOf: (tx: Tx) => SchedulingPorts;
}

export type ConfirmOutcome =
  | { ok: true; confirmation: PublicConfirmationDto; notice: BookingNotice }
  | { ok: false; refusal: 'not_found' | 'expired' | 'invalid_code' | 'limit_reached' };

export interface ConfirmInput extends SubmitInput {
  code: string;
}

/** The facts an event carries about an appointment. */
export function factsOf(appointment: AppointmentDto): AppointmentFacts {
  return {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    professionalId: appointment.professionalId,
    locationId: appointment.locationId,
    appointmentTypeId: appointment.appointmentTypeId,
    startsAt: new Date(appointment.startsAt),
    endsAt: new Date(appointment.endsAt),
    status: appointment.status,
    source: appointment.source,
    version: appointment.version,
  };
}

/**
 * Finishes a booking (online-booking, "Booking completion and patient identification"), in one
 * transaction: the code is checked, the booking rules are run again, the hold becomes the
 * appointment, and the patient is either created (confirmed identity) or the appointment is attached
 * to the patient with that document with the identity UNCONFIRMED (D14): the record is not changed,
 * no care relationship arises, and reception gets an identity review with the differences.
 *
 * Whatever happens to the patient, the answer is the same. A wrong code, a slot that is gone and a
 * contact that may not book are answered, not thrown, so the attempts they count are kept; a
 * failure after the code was accepted rolls the whole booking back, the code included.
 */
export async function confirmBooking(
  tx: Tx,
  deps: ConfirmDeps,
  input: ConfirmInput,
): Promise<ConfirmOutcome> {
  const loaded = await loadHold(tx, input);
  if ('refusal' in loaded) return { ok: false, refusal: loaded.refusal };
  const { offer, hold, typeId } = loaded;

  const [submission] = await tx
    .select()
    .from(bookingSubmission)
    .where(eq(bookingSubmission.holdId, hold.id))
    .for('update');
  if (submission?.status !== 'unverified') return { ok: false, refusal: 'not_found' };

  const verdict = await verifyCode(tx, {
    submissionId: submission.id,
    code: input.code,
    now: input.now,
  });
  if (verdict === 'invalid') return { ok: false, refusal: 'invalid_code' };

  const plain = await deps.keys.decryptField(
    tx,
    { ...SUBMISSION_FIELD, rowId: submission.id },
    submission.payloadEnc,
  );
  const payload = JSON.parse(plain.toString('utf8')) as SubmissionPayload;

  // The rules of a booking, run again: what was true when the visitor held the time may not be now.
  const settings = await readBookingSettings(tx);
  const type = offer.types.find((candidate) => candidate.id === typeId);
  const place = offer.locations.find((candidate) => candidate.id === hold.locationId);
  if (!type || !place) throw new SlotNoLongerAvailableError();
  if (
    settings.booking.dailyCap !== null &&
    dailyCapReached(
      settings.booking.dailyCap,
      await onlineBookingsOnDay(tx, {
        professionalId: offer.professionalId,
        startsAt: hold.startsAt,
        timeZone: place.timeZone,
      }),
    )
  ) {
    throw new SlotNoLongerAvailableError();
  }
  const future = await futureOnlineAppointments(tx, {
    email: submission.email,
    document: payload.document,
    now: input.now,
  });
  if (
    future >= ABUSE_LIMITS.futureAppointmentsPerContact ||
    (await bookingsInLastDay(tx, submission.email, input.now)) >=
      ABUSE_LIMITS.bookingsPerContactPerDay
  ) {
    await deps.abuse.recordSuspicious(tx, {
      actor: input.actor,
      reason: 'hoarding',
      linkId: offer.link.id,
    });
    return { ok: false, refusal: 'limit_reached' };
  }

  const ports = deps.portsOf(tx);
  const professional = await ports.lockProfessional(offer.professionalId);
  if (professional?.status !== 'active') throw new SlotNoLongerAvailableError();
  await ports.expireHolds(professional.id, input.now);
  const held = await ports.findHold(hold.id, { lock: true });
  // A staff override or the clock may have ended the hold since the visitor typed the code.
  if (held?.status !== 'active') throw new SlotNoLongerAvailableError();
  const blocks = await ports.blocks(professional.id, hold.locationId, {
    start: hold.startsAt.getTime(),
    end: hold.endsAt.getTime(),
  });
  if (blocks.length > 0) throw new SlotNoLongerAvailableError();

  // Who the appointment is for (D14): a new person, or the patient with that document.
  const match = await findPatientByDocument(tx, payload.document);
  if (match?.status === 'inactive') {
    // A deactivated record cannot be booked online, and the visitor is not told why.
    return { ok: false, refusal: 'limit_reached' };
  }
  let patientId: string;
  let identityConfirmed: boolean;
  let createdPatient = false;
  if (match) {
    patientId = match.id;
    identityConfirmed = false;
  } else {
    patientId = (
      await createOnlinePatient(tx, {
        actor: input.actor,
        givenNames: payload.givenNames,
        familyName: payload.familyName,
        birthDate: payload.birthDate,
        document: payload.document,
        phone: payload.phone,
        email: submission.email,
        consent: payload.consent.textKey
          ? { textKey: payload.consent.textKey, version: payload.consent.version }
          : null,
      })
    ).id;
    identityConfirmed = true;
    createdPatient = true;
  }

  // The hold stops occupying the range before the appointment takes it (one lane, one occupant).
  await ports.updateHold(hold.id, { status: 'converted' });
  const needsApproval = settings.booking.requireApproval || type.requiresApproval;
  const status = needsApproval ? 'pending_approval' : 'scheduled';
  const inserted = await ports.insertAppointment({
    patientId,
    professionalId: professional.id,
    locationId: hold.locationId,
    appointmentTypeId: type.id,
    startsAt: hold.startsAt,
    endsAt: hold.endsAt,
    bufferMinutes: hold.bufferMinutes,
    lane: hold.lane,
    status,
    source: 'online',
    bookedBy: null,
    identityConfirmed,
    outOfHours: false,
    overrideReason: null,
  });
  if (!inserted.ok) throw new SlotNoLongerAvailableError();
  const { appointment } = inserted;
  await ports.updateHold(hold.id, { appointmentId: appointment.id });

  if (!identityConfirmed && match) {
    await deps.worklist.openItem(tx, {
      kind: 'identity_review',
      subjectType: 'appointment',
      subjectId: appointment.id,
      locationId: hold.locationId,
      detail: {
        source: 'online_booking',
        differences: identityDifferences(match, {
          givenNames: payload.givenNames,
          familyName: payload.familyName,
          birthDate: payload.birthDate,
          phone: payload.phone,
          email: submission.email,
        }),
        // The visitor's choice is kept for staff; it is not recorded on a record nobody has checked.
        whatsappOptInRequested: payload.whatsappOptIn,
      },
    });
  }
  if (needsApproval) {
    await deps.worklist.openItem(tx, {
      kind: 'pending_approval',
      subjectType: 'appointment',
      subjectId: appointment.id,
      locationId: hold.locationId,
    });
  }

  await ports.insertEvent({
    appointmentId: appointment.id,
    kind: 'created',
    toStatus: status,
    actorUserId: null,
    actorKind: 'patient',
    details: { source: 'online' },
  });
  await ports.audit({
    action: 'appointment.created',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'appointment',
    resourceId: appointment.id,
    patientId,
    // The source and the channel the patient verified; no value they typed.
    metadata: {
      professionalId: professional.id,
      locationId: hold.locationId,
      startsAt: appointment.startsAt,
      identityConfirmed,
      source: 'online',
      channel: 'email',
    },
  });
  await audit(tx, {
    action: 'booking.online.created',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'appointment',
    resourceId: appointment.id,
    patientId,
    metadata: { channel: 'email', pendingApproval: needsApproval, newPatient: createdPatient },
  });
  await ports.publishEvent({ kind: 'created', appointment: factsOf(appointment) });

  if (createdPatient && payload.whatsappOptIn && deps.notifier.recordWhatsAppOptIn) {
    await deps.notifier.recordWhatsAppOptIn(tx, { patientId, at: input.now });
  }

  // What stays of the form: the consent it was made under. The rest was only needed to book.
  const evidence = await deps.keys.encryptField(
    tx,
    { ...SUBMISSION_FIELD, rowId: submission.id },
    JSON.stringify({ consent: payload.consent, whatsappOptInRequested: payload.whatsappOptIn }),
  );
  await tx
    .update(bookingSubmission)
    .set({
      status: 'verified',
      verifiedAt: input.now,
      appointmentId: appointment.id,
      payloadEnc: evidence,
    })
    .where(eq(bookingSubmission.id, submission.id));

  // The link to change or cancel lives until the appointment starts; the page says when the
  // organization's deadline has passed.
  const lifetime = Math.max(0, hold.startsAt.getTime() - input.now.getTime());
  const issued =
    lifetime > 0
      ? await deps.tokens.issue(tx, {
          kind: 'appointment_reschedule',
          subjectId: appointment.id,
          ttlMs: lifetime,
        })
      : null;

  const organizationName = await readOrganizationName(tx);
  const confirmation: PublicConfirmationDto = {
    status,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    timeZone: place.timeZone,
    organizationName,
    professionalName: offer.name,
    locationName: place.name,
    typeName: type.name,
    mode: type.mode,
    calendarFile: renderIcs({
      uid: appointment.id,
      organizationName,
      professionalName: offer.name,
      locationName: place.name,
      startsAt: hold.startsAt,
      endsAt: hold.endsAt,
      confirmed: status === 'scheduled',
      now: input.now,
    }),
    managePath: issued ? `/book/manage/${issued.token}` : null,
  };
  return {
    ok: true,
    confirmation,
    notice: {
      tenant: { id: input.tenant.id, slug: input.tenant.slug, isDemo: input.tenant.isDemo },
      to: submission.email,
      organizationName,
      professionalName: offer.name,
      locationName: place.name,
      startsAt: hold.startsAt,
      timeZone: place.timeZone,
      pendingApproval: needsApproval,
      manageToken: issued?.token ?? null,
      patientId,
      appointmentId: appointment.id,
    },
  };
}
