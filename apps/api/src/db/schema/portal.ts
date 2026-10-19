import {
  PORTAL_IDENTITY_STATUSES,
  PORTAL_LINK_RELATIONSHIPS,
  PORTAL_LINK_STATUSES,
  PORTAL_RELATIONS,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { citext, tenantTable } from './_helpers.js';
import { patient } from './patients.js';
import { tenant } from './tenant.js';

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One person's portal login within one organization (design 3.2, ADR-008). It is not a staff user:
 * it has no password, no role and no membership; it signs in with a code sent to its email. A
 * person who is a patient of two organizations has two identities, one in each (the tenant is part
 * of the unique key, and the table is isolated by it).
 *
 * - `invited`: staff invited the person, the activation link was not followed yet. The email is
 *   already reserved, so two invitations for one address cannot both be followed.
 * - `active`: the email was verified (the link, or the code of a registration). Only an active
 *   identity signs in.
 * - `deactivated`: staff ended the access. Nothing is deleted; the patient record is untouched.
 */
export const portalIdentity = tenantTable(
  'portal_identity',
  {
    email: citext('email').notNull(),
    status: text('status').notNull().default('invited'),
    /**
     * The patient the invitation was for: what the staff screen of that patient shows as a pending
     * invitation, and what tells a second invitation for the same person (it sends the link again)
     * from one for somebody else at the same address (it is refused).
     */
    invitedPatientId: uuid('invited_patient_id'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    /** The staff user who deactivated it. Null for a deactivation that was not a person's. */
    deactivatedBy: uuid('deactivated_by'),
  },
  (table) => [
    foreignKey({
      name: 'portal_identity_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'portal_identity_invited_patient_fkey',
      columns: [table.tenantId, table.invitedPatientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    // A verified email maps to at most one identity per organization.
    unique('portal_identity_tenant_id_email_key').on(table.tenantId, table.email),
    index('portal_identity_invited_patient_idx').on(table.tenantId, table.invitedPatientId),
    check(
      'portal_identity_status_check',
      sql`${table.status} in (${list(PORTAL_IDENTITY_STATUSES)})`,
    ),
    check(
      'portal_identity_activated_check',
      sql`${table.status} <> 'active' or ${table.activatedAt} is not null`,
    ),
    check(
      'portal_identity_deactivated_check',
      sql`(${table.status} = 'deactivated') = (${table.deactivatedAt} is not null)`,
    ),
  ],
);

export type PortalIdentityRow = typeof portalIdentity.$inferSelect;

/**
 * What an identity may read: a patient of the same organization, as themselves (`self`) or as the
 * representative of a dependent. The composite foreign keys keep a link inside the tenant.
 *
 * One live self link per identity and one per patient (the partial unique indexes below). A
 * revoked link frees both, so a patient whose account was ended can be invited again; the live
 * ones can never be doubled. A representative link records the relation and what the organization
 * verified, and `majority_review_on` is the day the dependent turns 18 (the daily review suspends
 * the link until the adult authorizes it).
 */
export const portalLink = tenantTable(
  'portal_link',
  {
    portalIdentityId: uuid('portal_identity_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    relationship: text('relationship').notNull(),
    relation: text('relation'),
    /** What the organization checked before linking a dependent. Administrative text, never clinical. */
    verificationNote: text('verification_note'),
    status: text('status').notNull().default('active'),
    majorityReviewOn: date('majority_review_on', { mode: 'string' }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** The staff user who ended it. Null when the adult ended it from their own identity. */
    revokedBy: uuid('revoked_by'),
    /** The staff user who created it. Null for a link made by the registration of the patient. */
    createdBy: uuid('created_by'),
  },
  (table) => [
    foreignKey({
      name: 'portal_link_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'portal_link_identity_fkey',
      columns: [table.tenantId, table.portalIdentityId],
      foreignColumns: [portalIdentity.tenantId, portalIdentity.id],
    }),
    foreignKey({
      name: 'portal_link_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    check(
      'portal_link_relationship_check',
      sql`${table.relationship} in (${list(PORTAL_LINK_RELATIONSHIPS)})`,
    ),
    check('portal_link_status_check', sql`${table.status} in (${list(PORTAL_LINK_STATUSES)})`),
    // A representative says who they are to the dependent, and the organization says what it verified.
    check(
      'portal_link_relation_check',
      sql`(${table.relationship} = 'representative') = (${table.relation} is not null)
        and (${table.relation} is null or ${table.relation} in (${list(PORTAL_RELATIONS)}))`,
    ),
    check(
      'portal_link_verification_check',
      sql`${table.relationship} = 'self' or ${table.verificationNote} is not null`,
    ),
    check(
      'portal_link_revoked_check',
      sql`(${table.status} = 'revoked') = (${table.revokedAt} is not null)`,
    ),
    uniqueIndex('portal_link_self_identity_key')
      .on(table.tenantId, table.portalIdentityId)
      .where(sql`${table.relationship} = 'self' and ${table.status} <> 'revoked'`),
    uniqueIndex('portal_link_self_patient_key')
      .on(table.tenantId, table.patientId)
      .where(sql`${table.relationship} = 'self' and ${table.status} <> 'revoked'`),
    uniqueIndex('portal_link_pair_key')
      .on(table.tenantId, table.portalIdentityId, table.patientId)
      .where(sql`${table.status} <> 'revoked'`),
    index('portal_link_patient_idx').on(table.tenantId, table.patientId),
    index('portal_link_majority_idx')
      .on(table.majorityReviewOn)
      .where(sql`${table.status} = 'active' and ${table.majorityReviewOn} is not null`),
  ],
);

export type PortalLinkRow = typeof portalLink.$inferSelect;

/**
 * A portal session (`psid` cookie). Only the SHA-256 of the opaque token is stored. It lives 30
 * minutes without use and 12 hours at most. It is a different id space from the staff session: a
 * staff cookie opens no portal route and this one opens no staff route. `selected_link_id` is the
 * subject the person picked (validated to belong to the identity); every portal read runs for it.
 */
export const portalSession = tenantTable(
  'portal_session',
  {
    portalIdentityId: uuid('portal_identity_id').notNull(),
    selectedLinkId: uuid('selected_link_id'),
    tokenHash: text('token_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Absolute lifetime. The idle timeout is derived from `last_seen_at`. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    /** The staff user who ended it, when an administrator did. */
    revokedBy: uuid('revoked_by'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    foreignKey({
      name: 'portal_session_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'portal_session_identity_fkey',
      columns: [table.tenantId, table.portalIdentityId],
      foreignColumns: [portalIdentity.tenantId, portalIdentity.id],
    }),
    foreignKey({
      name: 'portal_session_link_fkey',
      columns: [table.tenantId, table.selectedLinkId],
      foreignColumns: [portalLink.tenantId, portalLink.id],
    }),
    uniqueIndex('portal_session_token_hash_key').on(table.tokenHash),
    index('portal_session_identity_idx')
      .on(table.tenantId, table.portalIdentityId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export type PortalSessionRow = typeof portalSession.$inferSelect;
