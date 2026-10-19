import { z } from 'zod';

export { CONSENT_ERRORS, CONSENT_AUDIT_ACTIONS } from './consent-catalog.js';

/**
 * Contracts of the consent module (informed consent: versioned templates, requests, signatures and
 * revocations). This file holds what is certain from the design and the spec; the consent track
 * (S5.02, S5.03, S5.11) adds its request and response shapes below, in this file only. The consent
 * to the processing of personal data (Ley 25.326) is a different thing and lives in `patients.ts`.
 */

/** A template is edited as a draft, published as a numbered version, and retired when replaced. */
export const CONSENT_TEMPLATE_STATUSES = ['draft', 'published', 'retired'] as const;
export type ConsentTemplateStatus = (typeof CONSENT_TEMPLATE_STATUSES)[number];

/** Where a request stands. A signature is immutable: `revoked` is a new event beside it. */
export const CONSENT_REQUEST_STATUSES = [
  'pending',
  'signed',
  'declined',
  'expired',
  'revoked',
] as const;
export type ConsentRequestStatus = (typeof CONSENT_REQUEST_STATUSES)[number];

/** How a consent is collected: on a device at the practice, or by the patient in the portal. */
export const CONSENT_METHODS = ['in_person', 'portal'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/** Who signs: the patient, or the representative of a patient who cannot (a minor). */
export const CONSENT_SIGNER_KINDS = ['patient', 'representative'] as const;
export type ConsentSignerKind = (typeof CONSENT_SIGNER_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// Templates (S5.02)
// ---------------------------------------------------------------------------------------------

/** Longest title and body of a template. The database enforces the same limits. */
export const CONSENT_TITLE_MAX_LENGTH = 160;
export const CONSENT_BODY_MAX_LENGTH = 20_000;

/** Specialties are lower-case identifiers, the same shape as the template kinds of clinical notes. */
const SpecialtyKey = z.string().regex(/^[a-z][a-z_]{0,39}$/, 'invalid');

const TemplateTitle = z.string().trim().min(1, 'required').max(CONSENT_TITLE_MAX_LENGTH);
const TemplateBody = z
  .string()
  .max(CONSENT_BODY_MAX_LENGTH)
  .refine((text) => text.trim().length > 0, 'required');

export const CreateConsentTemplateRequest = z.strictObject({
  title: TemplateTitle,
  /** The working copy of the text. Publishing turns it into version 1. */
  body: TemplateBody,
  specialty: SpecialtyKey.nullable().optional(),
  /** The appointment type the template is meant for (a hint; the requirement is set apart). */
  appointmentTypeId: z.uuid().nullable().optional(),
  /** The starter the text came from, when it did. */
  starterKey: z.string().min(1).max(60).optional(),
});
export type CreateConsentTemplateRequest = z.infer<typeof CreateConsentTemplateRequest>;

/**
 * Changing a template. On a draft the working copy changes in place. On a published template, a new
 * title or text publishes the next version at once; only the specialty and the appointment type
 * change without one.
 */
export const UpdateConsentTemplateRequest = z
  .strictObject({
    title: TemplateTitle.optional(),
    body: TemplateBody.optional(),
    specialty: SpecialtyKey.nullable().optional(),
    appointmentTypeId: z.uuid().nullable().optional(),
  })
  .refine((request) => Object.keys(request).length > 0, {
    message: 'nothing to change',
  });
export type UpdateConsentTemplateRequest = z.infer<typeof UpdateConsentTemplateRequest>;

export const ConsentTemplateDto = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  /** The working copy of the text (what the next publish turns into a version). */
  body: z.string(),
  status: z.enum(CONSENT_TEMPLATE_STATUSES),
  specialty: z.string().nullable(),
  appointmentTypeId: z.uuid().nullable(),
  starterKey: z.string().nullable(),
  /** The number of the latest published version; null while the template is a draft. */
  latestVersionNumber: z.number().int().nullable(),
  versionCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  retiredAt: z.string().nullable(),
});
export type ConsentTemplateDto = z.infer<typeof ConsentTemplateDto>;

export const ConsentTemplateVersionDto = z.strictObject({
  id: z.uuid(),
  templateId: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  /** SHA-256 (hex) of the canonical title and text: what a signature binds to. */
  contentHash: z.string(),
  publishedAt: z.string(),
  /** The latest version of its template. */
  latest: z.boolean(),
});
export type ConsentTemplateVersionDto = z.infer<typeof ConsentTemplateVersionDto>;

export const ConsentTemplateListResponse = z.strictObject({
  templates: z.array(ConsentTemplateDto),
});
export type ConsentTemplateListResponse = z.infer<typeof ConsentTemplateListResponse>;

export const ConsentTemplateDetailResponse = z.strictObject({
  template: ConsentTemplateDto,
  /** Every published version, newest first. Earlier versions stay viewable. */
  versions: z.array(ConsentTemplateVersionDto),
});
export type ConsentTemplateDetailResponse = z.infer<typeof ConsentTemplateDetailResponse>;

/** A text to start from, per specialty (the product ships them in Spanish). */
export const ConsentStarterDto = z.strictObject({
  key: z.string(),
  specialty: z.string(),
  title: z.string(),
  body: z.string(),
});
export type ConsentStarterDto = z.infer<typeof ConsentStarterDto>;

export const ConsentStartersResponse = z.strictObject({ starters: z.array(ConsentStarterDto) });
export type ConsentStartersResponse = z.infer<typeof ConsentStartersResponse>;

/** What can be requested from a patient: the latest published version of each live template. */
export const OfferedConsentTemplateDto = z.strictObject({
  templateId: z.uuid(),
  versionId: z.uuid(),
  versionNumber: z.number().int(),
  title: z.string(),
  specialty: z.string().nullable(),
});
export type OfferedConsentTemplateDto = z.infer<typeof OfferedConsentTemplateDto>;

export const OfferedConsentTemplatesResponse = z.strictObject({
  templates: z.array(OfferedConsentTemplateDto),
});
export type OfferedConsentTemplatesResponse = z.infer<typeof OfferedConsentTemplatesResponse>;

// ---------------------------------------------------------------------------------------------
// Requests, signing and revocation (S5.03)
// ---------------------------------------------------------------------------------------------

/** A request that nobody signs ends after this many days unless the staff say otherwise. */
export const CONSENT_DEFAULT_EXPIRY_DAYS = 14;
export const CONSENT_MAX_EXPIRY_DAYS = 90;
/** The longest drawn signature (a PNG as a data URL), in characters. */
export const CONSENT_MARK_IMAGE_MAX_CHARS = 150_000;
export const CONSENT_REASON_MAX_LENGTH = 500;

export const CreateConsentRequestRequest = z.strictObject({
  patientId: z.uuid(),
  /** The template to ask for: the request is made for its latest published version. */
  templateId: z.uuid(),
  method: z.enum(CONSENT_METHODS),
  appointmentId: z.uuid().optional(),
  encounterId: z.uuid().optional(),
  expiresInDays: z.number().int().min(1).max(CONSENT_MAX_EXPIRY_DAYS).optional(),
});
export type CreateConsentRequestRequest = z.infer<typeof CreateConsentRequestRequest>;

export const ConsentRequestDto = z.strictObject({
  id: z.uuid(),
  patientId: z.uuid(),
  templateId: z.uuid(),
  versionId: z.uuid(),
  versionNumber: z.number().int(),
  /** `pending` shows as `expired` once its date has passed, even before the job records it. */
  status: z.enum(CONSENT_REQUEST_STATUSES),
  method: z.enum(CONSENT_METHODS),
  createdAt: z.string(),
  expiresAt: z.string(),
  signedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
});
export type ConsentRequestDto = z.infer<typeof ConsentRequestDto>;

/**
 * One consent in the list of a patient. The title is null for who may not see it: the screen shows
 * the neutral label ("Consentimiento") then (informed-consent, "Visibility and access control").
 */
export const ConsentListItemDto = z.strictObject({
  id: z.uuid(),
  status: z.enum(CONSENT_REQUEST_STATUSES),
  method: z.enum(CONSENT_METHODS),
  createdAt: z.string(),
  expiresAt: z.string(),
  signedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  title: z.string().nullable(),
  versionNumber: z.number().int().nullable(),
  /** Whether the viewer may open the signed record (a treating professional, or the patient). */
  canOpen: z.boolean(),
});
export type ConsentListItemDto = z.infer<typeof ConsentListItemDto>;

export const ConsentListResponse = z.strictObject({ consents: z.array(ConsentListItemDto) });
export type ConsentListResponse = z.infer<typeof ConsentListResponse>;

/** The exact version a signer is shown. */
export const ConsentVersionContentDto = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  title: z.string(),
  body: z.string(),
  contentHash: z.string(),
});
export type ConsentVersionContentDto = z.infer<typeof ConsentVersionContentDto>;

/** What the signing screen shows: the full text of the version bound to the request. */
export const ConsentSigningViewDto = z.strictObject({
  requestId: z.uuid(),
  status: z.enum(CONSENT_REQUEST_STATUSES),
  method: z.enum(CONSENT_METHODS),
  expiresAt: z.string(),
  patientName: z.string(),
  /** A minor is never marked as the signer: the screen asks for the representative. */
  requiresRepresentative: z.boolean(),
  version: ConsentVersionContentDto,
});
export type ConsentSigningViewDto = z.infer<typeof ConsentSigningViewDto>;

export const ConsentRepresentativeInput = z.strictObject({
  name: z.string().trim().min(2, 'required').max(120),
  nationalId: z.string().trim().min(5, 'required').max(20),
  relation: z.string().trim().min(2, 'required').max(60),
});
export type ConsentRepresentativeInput = z.infer<typeof ConsentRepresentativeInput>;

/** What the signer left as their mark: a typed name, or a drawing as a PNG data URL. */
export const ConsentMarkInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('typed'), name: z.string().trim().min(2, 'required').max(120) }),
  z.strictObject({
    kind: z.literal('drawn'),
    imageDataUrl: z.string().max(CONSENT_MARK_IMAGE_MAX_CHARS).startsWith('data:image/png;base64,'),
  }),
]);
export type ConsentMarkInput = z.infer<typeof ConsentMarkInput>;

export const SignConsentRequest = z.strictObject({
  /** The version the signer was shown: the signature binds to it and to nothing else. */
  versionId: z.uuid(),
  /** The explicit acceptance action: without it the signature is refused. */
  accepted: z.boolean(),
  signer: z.enum(CONSENT_SIGNER_KINDS),
  representative: ConsentRepresentativeInput.optional(),
  mark: ConsentMarkInput,
});
export type SignConsentRequest = z.infer<typeof SignConsentRequest>;

export const RevokeConsentRequest = z.strictObject({
  reason: z.string().trim().min(1).max(CONSENT_REASON_MAX_LENGTH).optional(),
});
export type RevokeConsentRequest = z.infer<typeof RevokeConsentRequest>;

/** The signed record, for who may open it (clinical.consent.read) and for the patient. */
export const SignedConsentDto = z.strictObject({
  request: ConsentRequestDto,
  version: ConsentVersionContentDto,
  signerKind: z.enum(CONSENT_SIGNER_KINDS),
  representative: ConsentRepresentativeInput.nullable(),
  mark: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('typed'), name: z.string() }),
    z.strictObject({ kind: z.literal('drawn'), imageDataUrl: z.string() }),
  ]),
  accepted: z.literal(true),
  method: z.enum(CONSENT_METHODS),
  signedAt: z.string(),
  contentFingerprint: z.string(),
  /** Recomputed from the stored facts: false means the record no longer matches its fingerprint. */
  fingerprintValid: z.boolean(),
  evidence: z.strictObject({
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    requestId: z.string().nullable(),
  }),
  revocation: z
    .strictObject({
      revokedAt: z.string(),
      channel: z.enum(CONSENT_METHODS),
      reason: z.string().nullable(),
    })
    .nullable(),
});
export type SignedConsentDto = z.infer<typeof SignedConsentDto>;

/** Whether an appointment needs a consent and whether a valid one exists. */
export const CONSENT_APPOINTMENT_STATES = ['not_required', 'valid', 'missing', 'revoked'] as const;
export type ConsentAppointmentState = (typeof CONSENT_APPOINTMENT_STATES)[number];

export const AppointmentConsentStatusDto = z.strictObject({
  appointmentId: z.uuid(),
  state: z.enum(CONSENT_APPOINTMENT_STATES),
  /** The template the appointment type requires; null when none. Never its title. */
  templateId: z.uuid().nullable(),
});
export type AppointmentConsentStatusDto = z.infer<typeof AppointmentConsentStatusDto>;

/** The appointment types and the consent each one requires (set apart from the scheduling setup). */
export const ConsentRequirementDto = z.strictObject({
  appointmentTypeId: z.uuid(),
  appointmentTypeName: z.string(),
  templateId: z.uuid().nullable(),
});
export type ConsentRequirementDto = z.infer<typeof ConsentRequirementDto>;

export const ConsentRequirementsResponse = z.strictObject({
  requirements: z.array(ConsentRequirementDto),
});
export type ConsentRequirementsResponse = z.infer<typeof ConsentRequirementsResponse>;

export const SetConsentRequirementRequest = z.strictObject({
  /** The template a valid consent of is required, or null to stop requiring one. */
  templateId: z.uuid().nullable(),
});
export type SetConsentRequirementRequest = z.infer<typeof SetConsentRequirementRequest>;

/** The answer to a new request: the request, and whether the patient was told by email. */
export const CONSENT_NOTICE_OUTCOMES = ['sent', 'not_sent', 'not_needed'] as const;

export const CreateConsentRequestResponse = z.strictObject({
  request: ConsentRequestDto,
  /**
   * `sent` when the email went out, `not_sent` when the patient could not be reached by email (no
   * address, opted out, or the provider failed) so the staff tell them another way, `not_needed`
   * when the consent is signed in person.
   */
  notice: z.enum(CONSENT_NOTICE_OUTCOMES),
});
export type CreateConsentRequestResponse = z.infer<typeof CreateConsentRequestResponse>;
