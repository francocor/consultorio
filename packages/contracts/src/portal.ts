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
