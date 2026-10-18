import type { PublicSubmissionRequest } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { bookingSubmission } from '../../../db/schema/booking-submission.js';
import { publicHold } from '../../../db/schema/online-booking.js';
import { slotHold } from '../../../db/schema/scheduling.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { isFutureDate, isMinor } from '../domain/age.js';
import { CODE_SENDS_PER_HOUR, maskEmail } from '../domain/otp.js';

import type { Abuse } from './abuse.js';
import { countryRulesFor } from './country-rules.js';
import { issueChallenge, sendsInLastHour } from './otp.js';
import {
  findOfferByProfessional,
  type OfferContext,
  type ProfessionalOffer,
} from './public-offer.js';

/** How long an unverified form is kept before `booking.purge` deletes it. */
export const SUBMISSION_LIFETIME_MS = 24 * 3_600_000;

export const SUBMISSION_FIELD = { table: 'booking_submission', column: 'payload_enc' } as const;

/** What the encrypted payload of a booking submission holds (everything except the email). */
export interface SubmissionPayload {
  givenNames: string;
  familyName: string;
  document: { type: string; number: string };
  birthDate: string;
  phone: string | null;
  whatsappOptIn: boolean;
  reason: string | null;
  consent: { textKey: string; version: string; at: string };
}

export interface SubmissionDeps {
  keys: TenantKeys;
  jobs: JobClient | undefined;
  abuse: Abuse;
}

export type SubmitOutcome =
  | { ok: true; maskedEmail: string; codeExpiresAt: Date }
  /** The hold is not the visitor's, or is gone: it looks like one that never existed. */
  | { ok: false; refusal: 'not_found' }
  /** The ten minutes passed, or staff took the slot. */
  | { ok: false; refusal: 'expired' }
  | { ok: false; refusal: 'rate_limited' };

export interface SubmitInput {
  tenant: { id: string; country: string; slug: string; isDemo: boolean };
  organizationSlug: string;
  holdId: string;
  /** Hash of the anonymous booking session that made the hold. */
  sourceKey: string;
  /** Address the request came from, for the per-source limit. */
  ip: string;
  actor: AuditActor;
  now: Date;
  offerContext: OfferContext;
}

export interface LoadedHold {
  offer: ProfessionalOffer;
  hold: typeof slotHold.$inferSelect;
  /** The type of visit the visitor chose when they held the time. */
  typeId: string;
}

/**
 * The hold a form belongs to, if it is the visitor's own and still alive. Anyone else's hold, a hold
 * that was already booked and a hold of a professional whose link is closed look like a hold that
 * never existed.
 */
export async function loadHold(
  tx: Tx,
  input: SubmitInput,
): Promise<LoadedHold | { refusal: 'not_found' | 'expired' }> {
  const [hold] = await tx.select().from(slotHold).where(eq(slotHold.id, input.holdId));
  if (hold?.origin !== 'public' || hold.sourceKey !== input.sourceKey) {
    return { refusal: 'not_found' };
  }
  if (hold.status === 'converted' || hold.status === 'released') return { refusal: 'not_found' };
  if (hold.status !== 'active' || hold.expiresAt.getTime() <= input.now.getTime()) {
    return { refusal: 'expired' };
  }
  const [made] = await tx.select().from(publicHold).where(eq(publicHold.holdId, hold.id));
  if (!made) return { refusal: 'not_found' };
  const offer = await findOfferByProfessional(
    tx,
    { organizationSlug: input.organizationSlug, professionalId: hold.professionalId },
    input.offerContext,
  );
  return offer ? { offer, hold, typeId: made.appointmentTypeId } : { refusal: 'not_found' };
}

function fieldError(path: string, i18nKey: string) {
  return { path, i18nKey };
}

/**
 * Keeps what the visitor typed until they prove they control the address (online-booking, "Booking
 * completion and patient identification"). Nothing is created that looks like a patient or an
 * appointment: the form is stored encrypted as an unverified submission, and a one-time code goes to
 * the address in the form and to no other. The form for a hold replaces the one before it.
 *
 * The answer is the same whether or not the document belongs to a patient: this function never reads
 * the patients or the appointments.
 */
export async function submitBooking(
  tx: Tx,
  deps: SubmissionDeps,
  input: SubmitInput & { form: Omit<PublicSubmissionRequest, 'challengeProof'> },
): Promise<SubmitOutcome> {
  const loaded = await loadHold(tx, input);
  if ('refusal' in loaded) return { ok: false, refusal: loaded.refusal };
  const { offer, hold } = loaded;
  const linkId = offer.link.id;

  if (
    !(await deps.abuse.allowSubmissionFrom(input.tenant.id, input.ip)) ||
    !(await deps.abuse.allowSubmissionOn(input.tenant.id, linkId))
  ) {
    await deps.abuse.recordSuspicious(tx, { actor: input.actor, reason: 'rate_limit', linkId });
    return { ok: false, refusal: 'rate_limited' };
  }

  const { form } = input;
  const rules = countryRulesFor(input.tenant.country);
  if (!rules) throw new AppError('unsupported_country');
  const errors: { path: string; i18nKey: string }[] = [];
  if (!form.dataProcessingConsent) {
    errors.push(fieldError('dataProcessingConsent', 'booking.consent_required'));
  }
  const document = rules.validateDocument(form.document.type, form.document.number);
  if (!document.ok) errors.push(fieldError('document', document.error.i18nKey));
  if (isFutureDate(form.birthDate, input.now)) {
    errors.push(fieldError('birthDate', 'booking.birth_date_future'));
  } else if (isMinor(form.birthDate, rules.majorityAge, input.now)) {
    // A minor is booked through the organization, which can register who answers for them.
    errors.push(fieldError('birthDate', 'booking.minor_contact_organization'));
  }
  if (form.whatsappOptIn && (form.phone === undefined || form.phone.replace(/\D/g, '') === '')) {
    errors.push(fieldError('phone', 'booking.phone_required_for_whatsapp'));
  }
  if (errors.length > 0 || !document.ok) throw new AppError('validation_failed', errors);

  // What a contact already holds (appointments per address and per document) is NOT looked at
  // here: this answer reaches somebody who has proved nothing, and a refusal for a document would
  // tell them that it has appointments. The limits are applied when the code is accepted, on the
  // address that was verified (`confirmBooking`).

  // Three codes an hour to one address, however it got there.
  if ((await sendsInLastHour(tx, form.email, input.now)) >= CODE_SENDS_PER_HOUR) {
    await deps.abuse.recordSuspicious(tx, { actor: input.actor, reason: 'code_flood', linkId });
    return { ok: false, refusal: 'rate_limited' };
  }
  if (!deps.jobs) throw new AppError('service_unavailable');

  const payload: SubmissionPayload = {
    givenNames: form.givenNames,
    familyName: form.familyName,
    document: document.value,
    birthDate: form.birthDate,
    phone: form.phone === undefined || form.phone === '' ? null : form.phone,
    whatsappOptIn: form.whatsappOptIn,
    reason: form.reason === undefined || form.reason === '' ? null : form.reason,
    consent: { ...rules.consent, at: input.now.toISOString() },
  };
  const [existing] = await tx
    .select({ id: bookingSubmission.id, status: bookingSubmission.status })
    .from(bookingSubmission)
    .where(eq(bookingSubmission.holdId, hold.id))
    .for('update');
  if (existing?.status === 'verified') return { ok: false, refusal: 'not_found' };

  const id = existing?.id ?? uuidv7();
  const payloadEnc = await deps.keys.encryptField(
    tx,
    { ...SUBMISSION_FIELD, rowId: id },
    JSON.stringify(payload),
  );
  const purgeAfter = new Date(input.now.getTime() + SUBMISSION_LIFETIME_MS);
  if (existing) {
    await tx
      .update(bookingSubmission)
      .set({ email: form.email, payloadEnc, purgeAfter })
      .where(eq(bookingSubmission.id, id));
  } else {
    await tx.insert(bookingSubmission).values({
      id,
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      kind: 'booking',
      email: form.email,
      payloadEnc,
      holdId: hold.id,
      purgeAfter,
      createdAt: input.now,
    });
  }

  const issued = await issueChallenge(tx, {
    tenantId: input.tenant.id,
    purpose: 'booking',
    email: form.email,
    submissionId: id,
    now: input.now,
    jobs: deps.jobs,
  });
  if (issued.limited) {
    await deps.abuse.recordSuspicious(tx, { actor: input.actor, reason: 'code_flood', linkId });
    return { ok: false, refusal: 'rate_limited' };
  }
  return { ok: true, maskedEmail: maskEmail(form.email), codeExpiresAt: issued.expiresAt };
}

/**
 * Sends the code again for the form already stored for a hold. It is one more email to the same
 * address, so it counts against the same three an hour, and it ends the previous code.
 */
export async function resendCode(
  tx: Tx,
  deps: SubmissionDeps,
  input: SubmitInput,
): Promise<SubmitOutcome> {
  const loaded = await loadHold(tx, input);
  if ('refusal' in loaded) return { ok: false, refusal: loaded.refusal };
  const linkId = loaded.offer.link.id;

  const [stored] = await tx
    .select({
      id: bookingSubmission.id,
      email: bookingSubmission.email,
      status: bookingSubmission.status,
    })
    .from(bookingSubmission)
    .where(eq(bookingSubmission.holdId, loaded.hold.id))
    .for('update');
  if (stored?.status !== 'unverified') return { ok: false, refusal: 'not_found' };

  if (
    !(await deps.abuse.allowSubmissionFrom(input.tenant.id, input.ip)) ||
    !(await deps.abuse.allowSubmissionOn(input.tenant.id, linkId))
  ) {
    await deps.abuse.recordSuspicious(tx, { actor: input.actor, reason: 'rate_limit', linkId });
    return { ok: false, refusal: 'rate_limited' };
  }
  if (!deps.jobs) throw new AppError('service_unavailable');
  const issued = await issueChallenge(tx, {
    tenantId: input.tenant.id,
    purpose: 'booking',
    email: stored.email,
    submissionId: stored.id,
    now: input.now,
    jobs: deps.jobs,
  });
  if (issued.limited) {
    await deps.abuse.recordSuspicious(tx, { actor: input.actor, reason: 'code_flood', linkId });
    return { ok: false, refusal: 'rate_limited' };
  }
  return { ok: true, maskedEmail: maskEmail(stored.email), codeExpiresAt: issued.expiresAt };
}
