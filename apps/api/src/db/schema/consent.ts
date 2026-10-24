import {
  CONSENT_BODY_MAX_LENGTH,
  CONSENT_METHODS,
  CONSENT_REQUEST_STATUSES,
  CONSENT_SIGNER_KINDS,
  CONSENT_TEMPLATE_STATUSES,
  CONSENT_TITLE_MAX_LENGTH,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { encounter } from './clinical.js';
import { patient } from './patients.js';
import { appointment } from './scheduling.js';
import { tenant } from './tenant.js';

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** Specialties are lower-case identifiers, the same shape as the template kinds of clinical notes. */
const SPECIALTY_PATTERN = '^[a-z][a-z_]{0,39}$';

/**
 * A consent template of the organization (informed-consent, "Consent template authoring"): the
 * working copy an owner, an admin or a professional writes, before and after it is published. It
 * is not patient data. What a patient signs is a VERSION of it (`consent_template_version`), which
 * is immutable.
 *
 * - `draft`: never published; the title and body are edited in place.
 * - `published`: has at least one version. Editing it creates the next version at once (the working
 *   copy here follows the latest version), so what was published never changes.
 * - `retired`: no longer offered for new signatures. The versions and the signed consents stay.
 *
 * A template is retired, never deleted (the runtime role has no `DELETE`). `title` and `draft_body`
 * are the working copy; the version carries the title it was published with.
 */
export const consentTemplate = tenantTable(
  'consent_template',
  {
    title: text('title').notNull(),
    /** The working copy of the text: what the next publish turns into a version. */
    draftBody: text('draft_body').notNull().default(''),
    specialty: text('specialty'),
    /**
     * The appointment type this template is meant for, when it is meant for one. A hint with no
     * foreign key on purpose: `appointment_type.requires_consent_template_id` already points the
     * other way, and two keys would make a cycle that the demo reset cannot empty. The service
     * checks the type exists in the organization.
     */
    appointmentTypeId: uuid('appointment_type_id'),
    status: text('status').notNull().default('draft'),
    /** The starter this template was made from, when it was (a catalog key, never an id). */
    starterKey: text('starter_key'),
    createdBy: uuid('created_by').notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    retiredBy: uuid('retired_by'),
  },
  (table) => [
    foreignKey({
      name: 'consent_template_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    check(
      'consent_template_status_check',
      sql`${table.status} in (${list(CONSENT_TEMPLATE_STATUSES)})`,
    ),
    check(
      'consent_template_title_check',
      sql`length(btrim(${table.title})) between 1 and ${sql.raw(String(CONSENT_TITLE_MAX_LENGTH))}`,
    ),
    check(
      'consent_template_body_check',
      sql`length(${table.draftBody}) <= ${sql.raw(String(CONSENT_BODY_MAX_LENGTH))}`,
    ),
    check(
      'consent_template_specialty_check',
      sql`${table.specialty} is null or ${table.specialty} ~ ${sql.raw(`'${SPECIALTY_PATTERN}'`)}`,
    ),
    check(
      'consent_template_retired_check',
      sql`(${table.status} = 'retired') = (${table.retiredAt} is not null and ${table.retiredBy} is not null)`,
    ),
    index('consent_template_list_idx').on(table.tenantId, table.status, table.title),
  ],
);

/**
 * A published version of a template: the exact title and text a signer is shown, numbered from 1
 * within its template. Immutable (a trigger refuses any change, and the runtime role has no
 * `UPDATE` or `DELETE`): an edit publishes the next version and leaves this one as it was, because
 * signatures point at it. `content_hash` is the SHA-256 of the canonical title and body
 * (`modules/consent/domain/fingerprint.ts`), shared by publishing and signing.
 */
export const consentTemplateVersion = tenantTable(
  'consent_template_version',
  {
    templateId: uuid('template_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    contentHash: text('content_hash').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    publishedBy: uuid('published_by').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'consent_template_version_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'consent_template_version_template_fkey',
      columns: [table.tenantId, table.templateId],
      foreignColumns: [consentTemplate.tenantId, consentTemplate.id],
    }),
    unique('consent_template_version_tenant_id_template_id_number_key').on(
      table.tenantId,
      table.templateId,
      table.versionNumber,
    ),
    check('consent_template_version_number_check', sql`${table.versionNumber} >= 1`),
    check('consent_template_version_hash_check', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'consent_template_version_title_check',
      sql`length(btrim(${table.title})) between 1 and ${sql.raw(String(CONSENT_TITLE_MAX_LENGTH))}`,
    ),
    check(
      'consent_template_version_body_check',
      sql`length(btrim(${table.body})) between 1 and ${sql.raw(String(CONSENT_BODY_MAX_LENGTH))}`,
    ),
  ],
);

/**
 * A consent asked of a patient: which VERSION of which template, how it is collected and until
 * when it can be signed. The version is fixed when the request is made, so the signer is always
 * shown the text that was current then, even if a newer version is published before they sign.
 *
 * The state follows the rows beside it and is kept by the database, not by the services: the
 * insert of the signature makes the request `signed` (and `signed_at` is copied here), the insert
 * of a revocation makes it `revoked`. `signed_at` and `revoked_at` live here so that reception and
 * the administration can see the status and the dates of a consent WITHOUT reading the signature
 * (which only a professional reads). A request that nobody signed ends `declined` or `expired`.
 *
 * The template title never reaches a non-clinical role through this table: the read model applies
 * the neutral label (informed-consent, "Visibility and access control").
 */
export const consentRequest = tenantTable(
  'consent_request',
  {
    patientId: uuid('patient_id').notNull(),
    templateVersionId: uuid('template_version_id').notNull(),
    appointmentId: uuid('appointment_id'),
    encounterId: uuid('encounter_id'),
    status: text('status').notNull().default('pending'),
    method: text('method').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** The staff user who made the request. */
    requestedBy: uuid('requested_by').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** When a request ended without a signature: declined by the patient or expired. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'consent_request_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'consent_request_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'consent_request_version_fkey',
      columns: [table.tenantId, table.templateVersionId],
      foreignColumns: [consentTemplateVersion.tenantId, consentTemplateVersion.id],
    }),
    foreignKey({
      name: 'consent_request_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    foreignKey({
      name: 'consent_request_encounter_fkey',
      columns: [table.tenantId, table.encounterId],
      foreignColumns: [encounter.tenantId, encounter.id],
    }),
    check(
      'consent_request_status_check',
      sql`${table.status} in (${list(CONSENT_REQUEST_STATUSES)})`,
    ),
    check('consent_request_method_check', sql`${table.method} in (${list(CONSENT_METHODS)})`),
    // The shape of each state, so a request cannot be half signed or half closed.
    check(
      'consent_request_state_check',
      sql`(
        (${table.status} = 'pending'
          and ${table.signedAt} is null and ${table.revokedAt} is null and ${table.closedAt} is null)
        or (${table.status} = 'signed'
          and ${table.signedAt} is not null and ${table.revokedAt} is null and ${table.closedAt} is null)
        or (${table.status} = 'revoked'
          and ${table.signedAt} is not null and ${table.revokedAt} is not null and ${table.closedAt} is null)
        or (${table.status} in ('declined', 'expired')
          and ${table.signedAt} is null and ${table.revokedAt} is null and ${table.closedAt} is not null)
      )`,
    ),
    index('consent_request_patient_idx').on(table.tenantId, table.patientId, table.createdAt),
    index('consent_request_version_idx').on(table.tenantId, table.templateVersionId),
    index('consent_request_pending_expiry_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
    // One live request per patient and version: asking again while the first waits is a conflict.
    uniqueIndex('consent_request_pending_key')
      .on(table.tenantId, table.patientId, table.templateVersionId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

/**
 * The signature of a request: who signed (the patient, or a representative), that they accepted,
 * how, when, and the fingerprint that proves the signed record was not altered. Immutable for
 * every role: the runtime role has no UPDATE or DELETE and a trigger stops the owner too. A
 * correction is a new request and a new signature; a withdrawal is a row in `consent_revocation`.
 *
 * `payload_enc` holds, encrypted with the tenant data key (bound to this table, column and row),
 * what is personal and goes into the signed record: the representative's name, document and
 * relation, the mark (typed name or the drawn image) and the evidence of the signing context.
 * Reading a signature is clinical: the SELECT policy lets a health professional through when the
 * care relationship or the sharing scope allow it, and lets the portal read the signature of the
 * very patient it serves (`app.consent_portal_patient`, set by the portal entry points). Writing
 * one is open to the staff that records an in-person signing and to the portal.
 */
export const consentSignature = tenantTable(
  'consent_signature',
  {
    requestId: uuid('request_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    templateVersionId: uuid('template_version_id').notNull(),
    signerKind: text('signer_kind').notNull(),
    accepted: boolean('accepted').notNull(),
    method: text('method').notNull(),
    payloadEnc: bytea('payload_enc').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    /** The staff user at the device, for an in-person signing. */
    recordedBy: uuid('recorded_by'),
    /** The portal identity, for a signing from the portal. */
    portalIdentityId: uuid('portal_identity_id'),
  },
  (table) => [
    foreignKey({
      name: 'consent_signature_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'consent_signature_request_fkey',
      columns: [table.tenantId, table.requestId],
      foreignColumns: [consentRequest.tenantId, consentRequest.id],
    }),
    foreignKey({
      name: 'consent_signature_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'consent_signature_version_fkey',
      columns: [table.tenantId, table.templateVersionId],
      foreignColumns: [consentTemplateVersion.tenantId, consentTemplateVersion.id],
    }),
    // A request has one signature: a second signing is a new request.
    unique('consent_signature_tenant_id_request_id_key').on(table.tenantId, table.requestId),
    check(
      'consent_signature_signer_check',
      sql`${table.signerKind} in (${list(CONSENT_SIGNER_KINDS)})`,
    ),
    check('consent_signature_method_check', sql`${table.method} in (${list(CONSENT_METHODS)})`),
    check('consent_signature_accepted_check', sql`${table.accepted} = true`),
    check(
      'consent_signature_fingerprint_check',
      sql`${table.contentFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    // Who recorded it follows the way it was collected.
    check(
      'consent_signature_recorder_check',
      sql`(${table.method} = 'in_person' and ${table.recordedBy} is not null and ${table.portalIdentityId} is null)
        or (${table.method} = 'portal' and ${table.portalIdentityId} is not null and ${table.recordedBy} is null)`,
    ),
    index('consent_signature_patient_idx').on(table.tenantId, table.patientId),
  ],
);

/**
 * The withdrawal of a signed consent (informed-consent, "Revocation"): a NEW row beside the
 * signature, never an edit of it. One per request. Who withdrew follows the channel: a portal
 * identity (the patient or a representative), or the staff user who recorded an in-person
 * revocation. The reason is free text about a patient, so it is encrypted like the other
 * personal content. Immutable for every role.
 */
export const consentRevocation = tenantTable(
  'consent_revocation',
  {
    requestId: uuid('request_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    channel: text('channel').notNull(),
    actorUserId: uuid('actor_user_id'),
    portalIdentityId: uuid('portal_identity_id'),
    reasonEnc: bytea('reason_enc'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'consent_revocation_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'consent_revocation_request_fkey',
      columns: [table.tenantId, table.requestId],
      foreignColumns: [consentRequest.tenantId, consentRequest.id],
    }),
    foreignKey({
      name: 'consent_revocation_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    unique('consent_revocation_tenant_id_request_id_key').on(table.tenantId, table.requestId),
    check('consent_revocation_channel_check', sql`${table.channel} in (${list(CONSENT_METHODS)})`),
    check(
      'consent_revocation_actor_check',
      sql`(${table.channel} = 'in_person' and ${table.actorUserId} is not null and ${table.portalIdentityId} is null)
        or (${table.channel} = 'portal' and ${table.portalIdentityId} is not null and ${table.actorUserId} is null)`,
    ),
    index('consent_revocation_patient_idx').on(table.tenantId, table.patientId),
  ],
);

export type ConsentTemplateRow = typeof consentTemplate.$inferSelect;
export type ConsentTemplateVersionRow = typeof consentTemplateVersion.$inferSelect;
export type ConsentRequestRow = typeof consentRequest.$inferSelect;
export type ConsentSignatureRow = typeof consentSignature.$inferSelect;
export type ConsentRevocationRow = typeof consentRevocation.$inferSelect;
