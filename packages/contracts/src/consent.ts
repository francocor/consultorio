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
