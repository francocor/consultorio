import { z } from 'zod';

import { REPRESENTATIVE_RELATIONS } from './patients.js';

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
