import { z } from 'zod';

import { CONSENT_MARK_IMAGE_MAX_CHARS } from './consent.js';
import { INVOICE_KINDS } from './invoicing.js';
import { REPRESENTATIVE_RELATIONS } from './patients.js';
import { PRESCRIPTION_STATUSES } from './prescriptions.js';
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

// Documents shared with the patient ---------------------------------------------------------------

/** A document the staff shared with the patient. The file is not in the list: it is asked for apart. */
export const PortalDocumentDto = z.strictObject({
  id: Id,
  name: z.string(),
  /** The category the organization filed it under (a lab result, a referral, ...). */
  category: z.string(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int(),
  sharedAt: Instant,
});
export type PortalDocumentDto = z.infer<typeof PortalDocumentDto>;

export const PortalDocumentsResponse = z.strictObject({ documents: z.array(PortalDocumentDto) });
export type PortalDocumentsResponse = z.infer<typeof PortalDocumentsResponse>;

/** Whether a document is shared with its patient, for the staff screen of the document. */
export const DocumentPortalShareResponse = z.strictObject({
  shared: z.boolean(),
  sharedAt: Instant.nullable(),
});
export type DocumentPortalShareResponse = z.infer<typeof DocumentPortalShareResponse>;

// Dependents ---------------------------------------------------------------------------------------

/** Somebody who represents the patient, as the patient (now an adult) sees them. */
export const PortalRepresentativeDto = z.strictObject({
  id: Id,
  relation: z.enum(PORTAL_RELATIONS),
  /** `suspended` is a representative whose link waits for the adult to authorize it. */
  status: z.enum(['active', 'suspended']),
  /** The first letter and the domain, so the patient can tell who it is. */
  maskedEmail: z.string(),
  majorityReviewOn: z.iso.date().nullable(),
});
export type PortalRepresentativeDto = z.infer<typeof PortalRepresentativeDto>;

export const PortalRepresentativesResponse = z.strictObject({
  representatives: z.array(PortalRepresentativeDto),
});
export type PortalRepresentativesResponse = z.infer<typeof PortalRepresentativesResponse>;

/** The organization authorizes a suspended representative again after verifying them. */
export const AuthorizePortalLinkRequest = z.strictObject({ verificationNote: VerificationNote });
export type AuthorizePortalLinkRequest = z.infer<typeof AuthorizePortalLinkRequest>;

// Downloads ----------------------------------------------------------------------------------------

/** A link to one file, for this session only: five minutes, one use. */
export const PortalDownloadLinkResponse = z.strictObject({
  /** An address of the portal (`/portal/files/<token>`), never of the storage. */
  url: z.string(),
  expiresAt: Instant,
});
export type PortalDownloadLinkResponse = z.infer<typeof PortalDownloadLinkResponse>;

// Invoices and receipts ---------------------------------------------------------------------------

/**
 * An invoice or credit note addressed to the patient themselves (an invoice to their payer is not
 * theirs to see). The lines, the tax breakdown and what the payer covers are not here: the patient
 * gets the voucher, as the PDF, and what they owe is the total on it.
 */
export const PortalInvoiceDto = z.strictObject({
  id: Id,
  kind: z.enum(INVOICE_KINDS),
  type: z.string(),
  pointOfSale: z.int(),
  number: z.int().nullable(),
  issueDate: z.iso.date(),
  totalCents: z.int(),
  hasPdf: z.boolean(),
  /** The voucher says "documento de prueba sin validez fiscal": a test environment or a simulator. */
  testDocument: z.boolean(),
});
export type PortalInvoiceDto = z.infer<typeof PortalInvoiceDto>;

export const PortalInvoicesResponse = z.strictObject({ invoices: z.array(PortalInvoiceDto) });
export type PortalInvoicesResponse = z.infer<typeof PortalInvoicesResponse>;

// Consents -----------------------------------------------------------------------------------------

export const PORTAL_CONSENT_STATUSES = [
  'pending',
  'signed',
  'revoked',
  'expired',
  'declined',
] as const;
export type PortalConsentStatus = (typeof PORTAL_CONSENT_STATUSES)[number];

/** A consent the organization asked the patient to sign, or that they signed. */
export const PortalConsentDto = z.strictObject({
  id: Id,
  /** The title of the document: the patient sees it, unlike reception. */
  title: z.string(),
  status: z.enum(PORTAL_CONSENT_STATUSES),
  requestedAt: Instant,
  signedAt: Instant.nullable(),
  revokedAt: Instant.nullable(),
  /** A request that is not signed by this day cannot be signed any more. */
  expiresAt: Instant.nullable(),
  canSign: z.boolean(),
  canRevoke: z.boolean(),
  /** A signed consent has a document to download. */
  hasDocument: z.boolean(),
});
export type PortalConsentDto = z.infer<typeof PortalConsentDto>;

export const PortalConsentsResponse = z.strictObject({
  /** False while no module serves consents: the screen shows its empty state. */
  available: z.boolean(),
  consents: z.array(PortalConsentDto),
});
export type PortalConsentsResponse = z.infer<typeof PortalConsentsResponse>;

/** The full text of what the patient is asked to sign. */
export const PortalConsentDetailDto = PortalConsentDto.extend({
  /** The text of the version the patient is shown; signing binds to exactly this version. */
  body: z.string(),
  /**
   * The fingerprint of the text shown (SHA-256, hex): the signature sends it back and the server
   * checks it is still the text of the version the request is bound to. Empty while there is no text
   * to sign.
   */
  contentHash: z.string(),
  /** The subject is a minor: the person who signs is the representative, with their data. */
  requiresRepresentative: z.boolean(),
});
export type PortalConsentDetailDto = z.infer<typeof PortalConsentDetailDto>;

export const PortalConsentSignRequest = z.strictObject({
  /** The explicit action: the box was ticked. A request without it is refused. */
  accepted: z.literal(true),
  /** The fingerprint of the text the patient was shown (`PortalConsentDetailDto.contentHash`). */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The full name of whoever signs (the patient, or the representative), kept with the record. */
  signerName: z.string().trim().min(2).max(120),
  /**
   * How the name was written: typed (at most 120 characters), or drawn on the pad (a PNG data URL;
   * the server decodes it and refuses what is not an image of reasonable size).
   */
  signature: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('typed'), value: z.string().trim().min(2).max(120) }),
    z.strictObject({
      kind: z.literal('drawn'),
      value: z.string().max(CONSENT_MARK_IMAGE_MAX_CHARS).startsWith('data:image/png;base64,'),
    }),
  ]),
  representative: z
    .strictObject({
      fullName: z.string().trim().min(2).max(120),
      nationalId: z.string().trim().min(1).max(32),
      relation: z.enum(PORTAL_RELATIONS),
    })
    .optional(),
});
export type PortalConsentSignRequest = z.infer<typeof PortalConsentSignRequest>;

export const PortalConsentRevokeRequest = z.strictObject({
  reason: z.string().trim().max(300).optional(),
});
export type PortalConsentRevokeRequest = z.infer<typeof PortalConsentRevokeRequest>;

export const PortalConsentResponse = z.strictObject({ consent: PortalConsentDto });
export type PortalConsentResponse = z.infer<typeof PortalConsentResponse>;

// Prescriptions ------------------------------------------------------------------------------------

/**
 * A prescription issued to the patient. It says that it exists, when, from whom and where it
 * stands; the medications are in the document, which is downloaded. A prescription the provider has
 * not confirmed is never listed as valid.
 */
export const PortalPrescriptionDto = z.strictObject({
  id: Id,
  issuedAt: Instant.nullable(),
  status: z.enum(PRESCRIPTION_STATUSES),
  prescriberName: z.string().nullable(),
  hasDocument: z.boolean(),
});
export type PortalPrescriptionDto = z.infer<typeof PortalPrescriptionDto>;

export const PortalPrescriptionsResponse = z.strictObject({
  /** False while no module serves prescriptions: the screen shows its empty state. */
  available: z.boolean(),
  prescriptions: z.array(PortalPrescriptionDto),
});
export type PortalPrescriptionsResponse = z.infer<typeof PortalPrescriptionsResponse>;

// The patient's own data ---------------------------------------------------------------------------

export const PortalRightsRequestDto = z.strictObject({
  id: Id,
  kind: z.enum(['access', 'rectification']),
  status: z.enum(['open', 'fulfilled']),
  requestedAt: Instant,
});
export type PortalRightsRequestDto = z.infer<typeof PortalRightsRequestDto>;

const PortalPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^[0-9+()\-\s.]*$/, 'digits and phone punctuation only');

export const PortalProfileResponse = z.strictObject({
  givenNames: z.string(),
  familyName: z.string(),
  birthDate: z.iso.date(),
  document: z.strictObject({ type: z.string(), number: z.string() }).nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  emergencyContact: z.strictObject({ name: z.string(), phone: z.string() }).nullable(),
  /** The version of the record the screen is showing; the change sends it back. */
  version: z.int(),
  /** The data-processing consent (Ley 25.326): standing or not, and since when. */
  dataProcessing: z.strictObject({ granted: z.boolean(), grantedAt: Instant.nullable() }),
  /** What the patient asked about their data, and whether the organization closed it. */
  requests: z.array(PortalRightsRequestDto),
});
export type PortalProfileResponse = z.infer<typeof PortalProfileResponse>;

/** The contact fields a patient changes by themselves. Name, document and birth date go by request. */
export const PortalProfileUpdateRequest = z
  .strictObject({
    phone: PortalPhone.nullable().optional(),
    address: z.string().trim().max(200).nullable().optional(),
    emergencyContact: z
      .strictObject({ name: z.string().trim().min(1).max(80), phone: PortalPhone.min(1) })
      .nullable()
      .optional(),
    expectedVersion: z.int().min(1).optional(),
  })
  .refine(
    (body) =>
      body.phone !== undefined || body.address !== undefined || body.emergencyContact !== undefined,
    'at least one field to change',
  );
export type PortalProfileUpdateRequest = z.infer<typeof PortalProfileUpdateRequest>;

/** The fields of the identity that the organization corrects after reviewing the request. */
export const PORTAL_RECTIFIABLE_FIELDS = [
  'familyName',
  'givenNames',
  'birthDate',
  'document',
] as const;
export type PortalRectifiableField = (typeof PORTAL_RECTIFIABLE_FIELDS)[number];

export const PortalRectificationRequest = z.strictObject({
  field: z.enum(PORTAL_RECTIFIABLE_FIELDS),
  /** What it should say. */
  correctValue: z.string().trim().min(1).max(100),
  note: z.string().trim().max(120).optional(),
});
export type PortalRectificationRequest = z.infer<typeof PortalRectificationRequest>;

/** Asks the organization for a copy of the clinical history, which it prepares outside the portal. */
export const PortalCopyRequest = z.strictObject({ note: z.string().trim().max(200).optional() });
export type PortalCopyRequest = z.infer<typeof PortalCopyRequest>;

export const PortalRequestResponse = z.strictObject({ request: PortalRightsRequestDto });
export type PortalRequestResponse = z.infer<typeof PortalRequestResponse>;

/**
 * Every response of the portal, by name. A contract test walks them: no shape of the portal may
 * carry a clinical note, a diagnosis, an anamnesis or the lines of a prescription (design D11).
 */
export const PORTAL_RESPONSE_SCHEMAS = {
  PortalMeResponse,
  PortalAppointmentsResponse,
  PortalAppointmentResponse,
  PortalDocumentsResponse,
  PortalInvoicesResponse,
  PortalConsentsResponse,
  PortalConsentDetailDto,
  PortalConsentResponse,
  PortalPrescriptionsResponse,
  PortalProfileResponse,
  PortalRequestResponse,
  PortalSessionsResponse,
  PortalRepresentativesResponse,
  PortalDownloadLinkResponse,
} as const;
