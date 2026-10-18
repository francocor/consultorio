import type {
  PublicWaitlistJoinRequest,
  WaitlistChannel,
  WaitlistTimeRange,
} from '@consultorio/contracts';
import { and, desc, eq, gt, sql } from 'drizzle-orm';

import { bookingSubmission, otpChallenge } from '../../../db/schema/booking-submission.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { evenOut } from '../../../platform/db/even-work.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import { clientKeyOf, type RateLimitStore } from '../../../platform/http/rate-limit.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { createOnlinePatient, findPatientByDocument } from '../../patients/index.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { isFutureDate, isMinor } from '../domain/age.js';
import {
  CODE_ATTEMPTS,
  CODE_LIFETIME_MS,
  CODE_SENDS_PER_HOUR,
  codeMatches,
  generateCode,
  hashCode,
  maskEmail,
} from '../domain/code.js';

import { countryRulesFor } from './country-rules.js';
import { createEntryRecord, DuplicateEntryError, type EntryDeps } from './entries.js';
import { renderJoinCodeEmail } from './join-email.js';
import { findJoinTarget } from './join-target.js';
import { loadWaitlistConfig } from './settings.js';

/** How long an unverified request is kept before `booking.purge` deletes it. */
export const JOIN_LIFETIME_MS = 24 * 3_600_000;

/** The limit of requests one address may send an hour. */
export const JOIN_REQUESTS_PER_ADDRESS = 10;

const HOUR = 3_600_000;
const FIELD = { table: 'booking_submission', column: 'payload_enc' } as const;

/** What the encrypted payload of a join holds (everything except the email). */
interface JoinPayload {
  givenNames: string;
  familyName: string;
  document: { type: string; number: string };
  birthDate: string;
  phone: string | null;
  channels: WaitlistChannel[];
  weekdays: number[];
  timeRanges: WaitlistTimeRange[];
  earliestDate: string | null;
  latestDate: string | null;
  professionalSlug: string;
  appointmentTypeId: string;
  locationId: string | null;
  consent: { textKey: string; version: string; at: string };
}

export interface JoinLimiter {
  /** Counts a request from this address; false once it sent too many in the hour. */
  allowFrom(tenantId: string, ip: string): Promise<boolean>;
}

export function createJoinLimiter(store: RateLimitStore): JoinLimiter {
  return {
    async allowFrom(tenantId, ip) {
      try {
        const state = await store.hit(`waitlist|join|source|${tenantId}|${clientKeyOf(ip)}`, HOUR);
        return state.count <= JOIN_REQUESTS_PER_ADDRESS;
      } catch {
        // The counters are best effort: a store that fails does not close the form.
        return true;
      }
    },
  };
}

export interface JoinDeps {
  keys: TenantKeys;
  /** Sends the code. It goes to the address in the form and to no other. */
  email: EmailSender;
  limiter: JoinLimiter;
  entries: EntryDeps;
  /**
   * The request to accept WhatsApp that a visitor made on the form, for a patient this join
   * created. The number they typed is not verified, so nothing is recorded: the notifications
   * module hands out a link, and the confirmation sends it to the address that was verified
   * (decision D22). Without it a WhatsApp choice stays a preference of the entry, and the delivery
   * still asks messaging for the opt-in before it uses WhatsApp.
   */
  whatsappOptIn?: WhatsappOptInPort;
}

/** What the waitlist asks of the notifications module about WhatsApp. */
export interface WhatsappOptInPort {
  /**
   * Inside the transaction of the join: prepares the link of this submission and returns its token.
   * It is asked for every join that ticked WhatsApp, whatever became of it (a new patient, one on
   * file, a record that cannot wait, an entry that was refused): the email must not tell the visitor
   * which. `created` says whether this join registered the patient; only then does following the
   * link opt in.
   */
  request(
    tx: Tx,
    input: { submissionId: string; patientId: string | null; created: boolean; at: Date },
  ): Promise<{ token: string }>;
  /** After the join is committed: emails the link to the address the visitor verified. */
  send(input: {
    tenant: { id: string; slug: string; isDemo: boolean };
    to: string;
    patientName: string;
    organizationName: string;
    token: string;
  }): Promise<void>;
}

/** The request to send once the join is committed. */
export interface PendingWhatsappOptIn {
  to: string;
  patientName: string;
  organizationName: string;
  token: string;
}

export interface JoinTenant {
  id: string;
  country: string;
  slug: string;
  isDemo: boolean;
}

export type JoinRefusal = 'not_found' | 'rate_limited';

async function recordSuspicious(
  tx: Tx,
  actor: AuditActor,
  linkId: string,
  reason: 'rate_limit' | 'code_flood',
): Promise<void> {
  await audit(tx, {
    action: 'booking.suspicious',
    outcome: 'deny',
    // What happened, never who: the address and the browser of the visitor are not kept.
    actor: { ...actor, ip: null, userAgent: null },
    resourceType: 'booking_link',
    resourceId: linkId,
    // What happened, never who: no address, name or document.
    metadata: { reason },
  });
}

/** How many codes were sent to an address in the last hour, whatever they were for. */
async function sendsInLastHour(tx: Tx, email: string, now: Date): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(otpChallenge)
    .where(
      and(
        eq(otpChallenge.email, email),
        gt(otpChallenge.createdAt, new Date(now.getTime() - HOUR)),
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Opens a challenge for the address and emails the code, in the same transaction: if the email
 * cannot be sent nothing was opened. The code is drawn and hashed here and exists in clear only in
 * the email. Asking again ends the earlier code (only the newest challenge counts).
 */
async function sendCode(
  tx: Tx,
  deps: JoinDeps,
  input: { tenant: JoinTenant; submissionId: string; email: string; now: Date },
): Promise<Date> {
  const expiresAt = new Date(input.now.getTime() + CODE_LIFETIME_MS);
  const [row] = await tx
    .insert(otpChallenge)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      purpose: 'waitlist_join',
      email: input.email,
      submissionId: input.submissionId,
      expiresAt,
      // The clock of the application, not the database's, decides how old a challenge is.
      createdAt: input.now,
    })
    .returning({ id: otpChallenge.id });
  if (!row) throw new Error('otp challenge insert returned no row');
  const code = generateCode();
  await tx
    .update(otpChallenge)
    .set({ codeHash: hashCode(row.id, code) })
    .where(eq(otpChallenge.id, row.id));
  await deps.email.send({
    to: input.email,
    tenant: { id: input.tenant.id, isDemo: input.tenant.isDemo },
    ...renderJoinCodeEmail({
      organizationName: await readOrganizationName(tx),
      code,
      expiresInMinutes: CODE_LIFETIME_MS / 60_000,
    }),
  });
  return expiresAt;
}

function fieldError(path: string, i18nKey: string) {
  return { path, i18nKey };
}

export type SubmitOutcome =
  | { ok: true; id: string; maskedEmail: string; codeExpiresAt: Date }
  | { ok: false; refusal: JoinRefusal };

/**
 * Keeps what the visitor typed until they prove they control the address (waitlist, "Joining the
 * waitlist"; online-booking, "Booking completion"). Nothing is created that looks like a patient or
 * an entry: the form is stored encrypted as an unverified submission, and a one-time code goes to
 * the address in the form. This function never reads the patients, so the answer is the same
 * whether or not the document belongs to somebody.
 */
export async function submitJoin(
  tx: Tx,
  deps: JoinDeps,
  input: {
    tenant: JoinTenant;
    organizationSlug: string;
    form: Omit<PublicWaitlistJoinRequest, 'challengeProof'>;
    ip: string;
    actor: AuditActor;
    now: Date;
  },
): Promise<SubmitOutcome> {
  const { form, now } = input;
  const target = await findJoinTarget(tx, {
    organizationSlug: input.organizationSlug,
    professionalSlug: form.professional,
    appointmentTypeId: form.appointmentTypeId,
    locationId: form.locationId,
  });
  if (!target) return { ok: false, refusal: 'not_found' };

  if (!(await deps.limiter.allowFrom(input.tenant.id, input.ip))) {
    await recordSuspicious(tx, input.actor, target.linkId, 'rate_limit');
    return { ok: false, refusal: 'rate_limited' };
  }

  const rules = countryRulesFor(input.tenant.country);
  if (!rules) throw new AppError('unsupported_country');
  const errors: { path: string; i18nKey: string }[] = [];
  if (!form.dataProcessingConsent) {
    errors.push(fieldError('dataProcessingConsent', 'waitlist.consent_required'));
  }
  const document = rules.validateDocument(form.document.type, form.document.number);
  if (!document.ok) errors.push(fieldError('document', document.error.i18nKey));
  if (isFutureDate(form.birthDate, now)) {
    errors.push(fieldError('birthDate', 'booking.birth_date_future'));
  } else if (isMinor(form.birthDate, rules.majorityAge, now)) {
    // A minor waits through the organization, which can register who answers for them.
    errors.push(fieldError('birthDate', 'booking.minor_contact_organization'));
  }
  if (form.channels.includes('whatsapp') && (form.phone ?? '').replace(/\D/g, '') === '') {
    errors.push(fieldError('phone', 'booking.phone_required_for_whatsapp'));
  }
  if (errors.length > 0 || !document.ok) throw new AppError('validation_failed', errors);
  // The agreement to receive offers is the point of the entry: without it there is nothing to join.
  if (!form.offersOptIn) throw new AppError('waitlist_opt_in_required');

  // Three codes an hour to one address, however it got there.
  if ((await sendsInLastHour(tx, form.email, now)) >= CODE_SENDS_PER_HOUR) {
    await recordSuspicious(tx, input.actor, target.linkId, 'code_flood');
    return { ok: false, refusal: 'rate_limited' };
  }

  const payload: JoinPayload = {
    givenNames: form.givenNames,
    familyName: form.familyName,
    document: document.value,
    birthDate: form.birthDate,
    phone: form.phone === undefined || form.phone === '' ? null : form.phone,
    channels: form.channels,
    weekdays: form.weekdays,
    timeRanges: form.timeRanges,
    earliestDate: form.earliestDate ?? null,
    latestDate: form.latestDate ?? null,
    professionalSlug: form.professional,
    appointmentTypeId: target.appointmentTypeId,
    locationId: target.locationId,
    consent: { ...rules.consent, at: now.toISOString() },
  };
  const id = uuidv7();
  await tx.insert(bookingSubmission).values({
    id,
    tenantId: sql`current_setting('app.tenant_id')::uuid`,
    kind: 'waitlist_join',
    email: form.email,
    payloadEnc: await deps.keys.encryptField(tx, { ...FIELD, rowId: id }, JSON.stringify(payload)),
    purgeAfter: new Date(now.getTime() + JOIN_LIFETIME_MS),
    createdAt: now,
  });
  const codeExpiresAt = await sendCode(tx, deps, {
    tenant: input.tenant,
    submissionId: id,
    email: form.email,
    now,
  });
  return { ok: true, id, maskedEmail: maskEmail(form.email), codeExpiresAt };
}

/** The unverified request a visitor asks about, locked; null when it is not theirs to continue. */
async function loadRequest(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(bookingSubmission)
    .where(and(eq(bookingSubmission.id, id), eq(bookingSubmission.kind, 'waitlist_join')))
    .for('update');
  return row?.status === 'unverified' ? row : null;
}

/**
 * Sends the code again for a request already stored. It is one more email to the same address, so
 * it counts against the same three an hour, and it ends the previous code.
 */
export async function resendJoinCode(
  tx: Tx,
  deps: JoinDeps,
  input: {
    tenant: JoinTenant;
    submissionId: string;
    ip: string;
    actor: AuditActor;
    now: Date;
  },
): Promise<SubmitOutcome> {
  const stored = await loadRequest(tx, input.submissionId);
  if (!stored) return { ok: false, refusal: 'not_found' };
  if (!(await deps.limiter.allowFrom(input.tenant.id, input.ip))) {
    return { ok: false, refusal: 'rate_limited' };
  }
  if ((await sendsInLastHour(tx, stored.email, input.now)) >= CODE_SENDS_PER_HOUR) {
    return { ok: false, refusal: 'rate_limited' };
  }
  const codeExpiresAt = await sendCode(tx, deps, {
    tenant: input.tenant,
    submissionId: stored.id,
    email: stored.email,
    now: input.now,
  });
  return { ok: true, id: stored.id, maskedEmail: maskEmail(stored.email), codeExpiresAt };
}

/**
 * Checks the code of a request. Only the newest challenge counts. A wrong code adds an attempt and
 * the fifth spends the challenge; the right code spends it too. It answers instead of throwing, so
 * the attempts it records are committed with the request.
 */
async function verifyCode(
  tx: Tx,
  input: { submissionId: string; code: string; now: Date },
): Promise<boolean> {
  const [challenge] = await tx
    .select()
    .from(otpChallenge)
    .where(eq(otpChallenge.submissionId, input.submissionId))
    .orderBy(desc(otpChallenge.createdAt), desc(otpChallenge.id))
    .limit(1)
    .for('update');
  if (!challenge || challenge.consumedAt !== null) return false;
  if (challenge.expiresAt.getTime() <= input.now.getTime()) return false;
  if (challenge.attempts >= CODE_ATTEMPTS) return false;

  if (codeMatches(challenge.id, input.code, challenge.codeHash)) {
    await tx
      .update(otpChallenge)
      .set({ consumedAt: input.now })
      .where(eq(otpChallenge.id, challenge.id));
    return true;
  }
  const attempts = challenge.attempts + 1;
  await tx
    .update(otpChallenge)
    .set({ attempts, ...(attempts >= CODE_ATTEMPTS ? { consumedAt: input.now } : {}) })
    .where(eq(otpChallenge.id, challenge.id));
  return false;
}

/**
 * What registering a new person costs over attaching the entry to an existing patient, in statements
 * sent to Postgres: the existing-patient branch sends this many reads so the work behind the answer
 * does not tell the two apart (see `evenOut`; pinned by `test/security/public-nondisclosure.test.ts`).
 * Ticking WhatsApp adds the same to every branch: each one asks for the link of the submission.
 */
export const JOIN_NEW_PERSON_EXTRA_STATEMENTS = 7;

export type ConfirmOutcome =
  | { ok: true; expiresAt: Date; whatsappOptIn?: PendingWhatsappOptIn }
  | { ok: false; refusal: 'not_found' | 'invalid_code' };

/**
 * Finishes a join once the visitor proved the address (waitlist, "Joining the waitlist";
 * online-booking, D14). In one transaction: the code is checked, and then either the person is
 * registered (a new patient, origin `online`, identity confirmed) or the entry is attached to the
 * patient with that document, with the identity UNCONFIRMED and the record left exactly as it was.
 *
 * The answer is the same in every case, including the ones where nothing is added: a patient who
 * already waits for the same thing, or who already holds the most entries, gets the answer of
 * anybody else. What a visitor types never tells them who is on file.
 */
export async function confirmJoin(
  tx: Tx,
  deps: JoinDeps,
  input: {
    tenant: JoinTenant;
    organizationSlug: string;
    submissionId: string;
    code: string;
    actor: AuditActor;
    now: Date;
  },
): Promise<ConfirmOutcome> {
  const stored = await loadRequest(tx, input.submissionId);
  if (!stored) return { ok: false, refusal: 'not_found' };
  if (!(await verifyCode(tx, { submissionId: stored.id, code: input.code, now: input.now }))) {
    return { ok: false, refusal: 'invalid_code' };
  }

  const plain = await deps.keys.decryptField(tx, { ...FIELD, rowId: stored.id }, stored.payloadEnc);
  const payload = JSON.parse(plain.toString('utf8')) as JoinPayload;
  // The address may have been closed since the visitor typed the form.
  const target = await findJoinTarget(tx, {
    organizationSlug: input.organizationSlug,
    professionalSlug: payload.professionalSlug,
    appointmentTypeId: payload.appointmentTypeId,
    locationId: payload.locationId ?? undefined,
  });
  if (!target) return { ok: false, refusal: 'not_found' };

  const config = await loadWaitlistConfig(tx);
  const expiresAt = new Date(input.now.getTime() + config.waitlist.entryExpiryDays * 86_400_000);

  const match = await findPatientByDocument(tx, payload.document);
  /** The patient this join registered, when the entry was accepted. */
  const registered: { patientId: string | null } = { patientId: null };
  // A deactivated record cannot wait for a turn, and the visitor is not told why.
  if (match?.status !== 'inactive') {
    try {
      // A savepoint: a patient registered for an entry that is then refused is not registered.
      await tx.transaction(async (inner) => {
        const created =
          match === null
            ? await createOnlinePatient(inner, {
                actor: input.actor,
                givenNames: payload.givenNames,
                familyName: payload.familyName,
                birthDate: payload.birthDate,
                document: payload.document,
                phone: payload.phone,
                email: stored.email,
                consent: { textKey: payload.consent.textKey, version: payload.consent.version },
              })
            : null;
        const patientId = created?.id ?? match?.id;
        if (!patientId) throw new Error('a join needs a patient');
        await createEntryRecord(inner, deps.entries, {
          actor: { ...input.actor, userId: null },
          now: input.now,
          entry: {
            patientId,
            appointmentTypeId: target.appointmentTypeId,
            professionalId: target.professionalId,
            locationId: target.locationId,
            weekdays: payload.weekdays,
            timeRanges: payload.timeRanges,
            earliestDate: payload.earliestDate,
            latestDate: payload.latestDate,
            channels: payload.channels,
            // The visitor typed a document, not a proof: they can say they want offers for their
            // own new record, but never for the record that already has that document (a stranger
            // would be forging the agreement of the patient). That entry waits for reception.
            optIn: match === null ? { source: 'public_join', recordedBy: null } : null,
            source: 'public_join',
            createdBy: null,
            identityUnconfirmed: match !== null,
          },
        });
        if (!created) await evenOut(inner, JOIN_NEW_PERSON_EXTRA_STATEMENTS);
        registered.patientId = created?.id ?? null;
      });
    } catch (error) {
      const refused =
        error instanceof DuplicateEntryError ||
        (error instanceof AppError && error.code === 'waitlist_entry_limit');
      if (!refused) {
        // Something about what is waited for is no longer true: the same answer as a dead address.
        if (error instanceof AppError) return { ok: false, refusal: 'not_found' };
        throw error;
      }
      // The savepoint was rolled back with the request: nobody was registered.
      registered.patientId = null;
    }
  }

  // The link to accept WhatsApp, for every join that asked for it, whatever became of it: a new
  // person, a patient on file, a record that cannot wait or an entry that was refused. The email
  // that carries it must not tell the visitor which one it was (judgment day round 2, finding A1).
  let whatsappOptIn: PendingWhatsappOptIn | undefined;
  if (payload.channels.includes('whatsapp') && deps.whatsappOptIn) {
    const requested = await deps.whatsappOptIn.request(tx, {
      submissionId: stored.id,
      patientId: registered.patientId,
      created: registered.patientId !== null,
      at: input.now,
    });
    whatsappOptIn = {
      to: stored.email,
      patientName: payload.givenNames,
      organizationName: await readOrganizationName(tx),
      token: requested.token,
    };
  }

  // What stays of the form: the consent it was made under. The rest was only needed to join.
  const evidence = await deps.keys.encryptField(
    tx,
    { ...FIELD, rowId: stored.id },
    JSON.stringify({ consent: payload.consent, channels: payload.channels }),
  );
  await tx
    .update(bookingSubmission)
    .set({ status: 'verified', verifiedAt: input.now, payloadEnc: evidence })
    .where(eq(bookingSubmission.id, stored.id));
  return { ok: true, expiresAt, ...(whatsappOptIn ? { whatsappOptIn } : {}) };
}
