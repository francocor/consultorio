import {
  CONSENT_BODY_MAX_LENGTH,
  CONSENT_TEMPLATE_STATUSES,
  CONSENT_TITLE_MAX_LENGTH,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
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

export type ConsentTemplateRow = typeof consentTemplate.$inferSelect;
export type ConsentTemplateVersionRow = typeof consentTemplateVersion.$inferSelect;
