import { z } from 'zod';

import { REPRESENTATIVE_RELATIONS } from './patients.js';
import { APPOINTMENT_STATUSES } from './scheduling.js';

export { PORTAL_ERRORS, PORTAL_AUDIT_ACTIONS } from './portal-catalog.js';

/**
 * Contracts of the portal module (the patient portal: identities, links, sign-in by emailed code,
 * read models and downloads). This file holds what is certain from the design (section 3.2 and
 * ADR-008); the portal track (S5.06 to S5.10) adds its request and response shapes below, in this
 * file only. No shape of the portal may carry a clinical note, a diagnosis or an anamnesis field.
 */

/** An identity is invited by staff, becomes active when the person follows the link, and can be deactivated. */
export const PORTAL_IDENTITY_STATUSES = ['invited', 'active', 'deactivated'] as const;
export type PortalIdentityStatus = (typeof PORTAL_IDENTITY_STATUSES)[number];

/** A person sees their own record (`self`) or that of somebody they represent (`representative`). */
export const PORTAL_LINK_RELATIONSHIPS = ['self', 'representative'] as const;
export type PortalLinkRelationship = (typeof PORTAL_LINK_RELATIONSHIPS)[number];

/** A representative link is suspended when the dependent turns 18, until the adult authorizes it. */
export const PORTAL_LINK_STATUSES = ['active', 'suspended', 'revoked'] as const;
export type PortalLinkStatus = (typeof PORTAL_LINK_STATUSES)[number];

const Id = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const PortalEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** What the organization checked before it linked a dependent or changed an address. Short, administrative. */
const VerificationNote = z.string().trim().min(10).max(500);

// Staff: the portal accounts of a patient ----------------------------------------------------------

/** The relation a representative has with a dependent (the same words the patient record uses). */
export const PORTAL_RELATIONS = REPRESENTATIVE_RELATIONS;
export type PortalRelation = (typeof PORTAL_RELATIONS)[number];

export const PortalLinkDto = z.strictObject({
  id: Id,
  patientId: Id,
  /** The name of the person the link is about, as the staff and the portal header show it. */
  patientName: z.string(),
  relationship: z.enum(PORTAL_LINK_RELATIONSHIPS),
  relation: z.enum(PORTAL_RELATIONS).nullable(),
  status: z.enum(PORTAL_LINK_STATUSES),
  /** The day the dependent reaches the age of majority and the representative link is reviewed. */
  majorityReviewOn: z.iso.date().nullable(),
  createdAt: Instant,
});
export type PortalLinkDto = z.infer<typeof PortalLinkDto>;

export const PortalIdentityDto = z.strictObject({
  id: Id,
  email: z.string(),
  status: z.enum(PORTAL_IDENTITY_STATUSES),
  activatedAt: Instant.nullable(),
  deactivatedAt: Instant.nullable(),
  links: z.array(PortalLinkDto),
});
export type PortalIdentityDto = z.infer<typeof PortalIdentityDto>;

/** The portal accounts that reach one patient, for the patient record. */
export const PatientPortalResponse = z.strictObject({ identities: z.array(PortalIdentityDto) });
export type PatientPortalResponse = z.infer<typeof PatientPortalResponse>;

/**
 * Invites a patient to the portal. With no body the patient is invited themselves, at the email on
 * their record. A representative is invited at THEIR OWN email, with the relation and the note of
 * what the organization checked (a representative link needs the organization's verification).
 */
export const PortalInvitationRequest = z
  .strictObject({
    email: PortalEmail.optional(),
    relation: z.enum(PORTAL_RELATIONS).optional(),
    verificationNote: VerificationNote.optional(),
  })
  .refine(
    (body) =>
      (body.email === undefined &&
        body.relation === undefined &&
        body.verificationNote === undefined) ||
      (body.email !== undefined &&
        body.relation !== undefined &&
        body.verificationNote !== undefined),
    'a representative needs an email, a relation and a verification note',
  );
export type PortalInvitationRequest = z.infer<typeof PortalInvitationRequest>;

/** What every change to a portal account answers with: the account as it is now. */
export const PortalIdentityResponse = z.strictObject({ identity: PortalIdentityDto });
export type PortalIdentityResponse = z.infer<typeof PortalIdentityResponse>;

/** Links one more dependent to an identity that already exists (a parent with two children). */
export const CreatePortalLinkRequest = z.strictObject({
  patientId: Id,
  relation: z.enum(PORTAL_RELATIONS),
  verificationNote: VerificationNote,
});
export type CreatePortalLinkRequest = z.infer<typeof CreatePortalLinkRequest>;

/** Changes the email of an identity after the organization verified the person out of band. */
export const ChangePortalEmailRequest = z.strictObject({
  email: PortalEmail,
  verificationNote: VerificationNote,
});
export type ChangePortalEmailRequest = z.infer<typeof ChangePortalEmailRequest>;

// Public: registering and signing in ---------------------------------------------------------------

const ChallengeProof = z.string().min(1).max(512);
const PortalCode = z.string().regex(/^\d{6}$/);
/** What a visitor types as their document: the country's rules decide what a valid one looks like. */
const NationalIdInput = z.string().trim().min(1).max(32);

/**
 * Registration: the document AND the email on the record, and the proof of the bot challenge. It is
 * answered the same way whatever the data (the answer never says whether the document exists).
 */
export const PortalRegisterRequest = z.strictObject({
  nationalId: NationalIdInput,
  email: PortalEmail,
  challengeProof: ChallengeProof,
});
export type PortalRegisterRequest = z.infer<typeof PortalRegisterRequest>;

/** The code that arrived at the address on the record. The document is asked again. */
export const PortalRegisterVerifyRequest = z.strictObject({
  nationalId: NationalIdInput,
  email: PortalEmail,
  code: PortalCode,
});
export type PortalRegisterVerifyRequest = z.infer<typeof PortalRegisterVerifyRequest>;

/** Asks for the code to sign in. Answered the same way for any email. */
export const PortalCodeRequest = z.strictObject({
  email: PortalEmail,
  challengeProof: ChallengeProof,
});
export type PortalCodeRequest = z.infer<typeof PortalCodeRequest>;

export const PortalCodeVerifyRequest = z.strictObject({ email: PortalEmail, code: PortalCode });
export type PortalCodeVerifyRequest = z.infer<typeof PortalCodeVerifyRequest>;

/** The only thing a request for a code says: it was received. */
export const PortalAcceptedResponse = z.strictObject({ accepted: z.literal(true) });
export type PortalAcceptedResponse = z.infer<typeof PortalAcceptedResponse>;

/** The session itself travels in the cookie; the answer only says it started. */
export const PortalSignedInResponse = z.strictObject({ signedIn: z.literal(true) });
export type PortalSignedInResponse = z.infer<typeof PortalSignedInResponse>;

// Portal: the sessions of the person ---------------------------------------------------------------

export const PortalSessionDto = z.strictObject({
  id: Id,
  createdAt: Instant,
  lastSeenAt: Instant,
  expiresAt: Instant,
  /** The browser, as it said it was. Null when it did not say. */
  userAgent: z.string().nullable(),
  /** The session that asked. */
  current: z.boolean(),
});
export type PortalSessionDto = z.infer<typeof PortalSessionDto>;

export const PortalSessionsResponse = z.strictObject({ sessions: z.array(PortalSessionDto) });
export type PortalSessionsResponse = z.infer<typeof PortalSessionsResponse>;

// Portal: whose data is shown ----------------------------------------------------------------------

/** What the portal can show today. A part with no module behind it shows its empty state. */
export const PortalCapabilities = z.strictObject({
  consents: z.boolean(),
  prescriptions: z.boolean(),
});
export type PortalCapabilities = z.infer<typeof PortalCapabilities>;

/** Who is signed in, the records they can pick from, and which one is shown. */
export const PortalMeResponse = z.strictObject({
  email: z.string(),
  organizationName: z.string(),
  /** The links that give access today: active ones, and the suspended ones the person must hear about. */
  links: z.array(PortalLinkDto),
  /** The link whose record is shown. Null until the person picks one. */
  selectedLinkId: Id.nullable(),
  capabilities: PortalCapabilities,
});
export type PortalMeResponse = z.infer<typeof PortalMeResponse>;

/** Picks the record that is shown. The server checks the link belongs to the person. */
export const PortalSubjectRequest = z.strictObject({ linkId: Id });
export type PortalSubjectRequest = z.infer<typeof PortalSubjectRequest>;

// Portal: appointments ----------------------------------------------------------------------------

export const PortalAppointmentDto = z.strictObject({
  id: Id,
  startsAt: Instant,
  endsAt: Instant,
  /** The zone of the place, for the screen to show the time the way the place keeps it. */
  timeZone: z.string(),
  status: z.enum(APPOINTMENT_STATUSES),
  professionalName: z.string(),
  locationName: z.string(),
  typeName: z.string(),
  mode: z.enum(['in_person', 'virtual']),
  /** The patient can still confirm it. */
  canConfirm: z.boolean(),
  /** The patient can still cancel it, inside the cancellation policy of the organization. */
  canCancel: z.boolean(),
  /** Until when the patient can cancel from the portal. After that, they contact the organization. */
  cancelDeadline: Instant.nullable(),
  /** The address to join a video appointment, when there is one. */
  joinUrl: z.string().nullable(),
  /** A video appointment whose address does not exist yet: the screen says it will follow. */
  joinPending: z.boolean(),
});
export type PortalAppointmentDto = z.infer<typeof PortalAppointmentDto>;

export const PortalAppointmentsResponse = z.strictObject({
  upcoming: z.array(PortalAppointmentDto),
  past: z.array(PortalAppointmentDto),
});
export type PortalAppointmentsResponse = z.infer<typeof PortalAppointmentsResponse>;

/** What confirming or cancelling answers with: the appointment as it is now. */
export const PortalAppointmentResponse = z.strictObject({ appointment: PortalAppointmentDto });
export type PortalAppointmentResponse = z.infer<typeof PortalAppointmentResponse>;
