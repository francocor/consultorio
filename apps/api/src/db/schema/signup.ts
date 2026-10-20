import { SIGNUP_TERMS_KINDS } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { citext, tenantTable } from './_helpers.js';
import { userAccount } from './identity.js';
import { tenant } from './tenant.js';

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * The versions of the terms a signup asks for (tenant-onboarding, "Privacy and legal acceptance").
 * A platform table: every organization reads the same rows, so it has no `tenant_id` and no row
 * level security. The runtime role can only read it; a new version is a data change made by the
 * owner connection (there is no console screen for it yet). Exactly one version of each kind is
 * current at a time.
 */
export const termsVersion = pgTable(
  'terms_version',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    /** `terms` (the terms of service) or `data_processing` (the data-processing terms). */
    kind: text('kind').notNull(),
    version: integer('version').notNull(),
    isCurrent: boolean('is_current').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('terms_version_kind_version_key').on(table.kind, table.version),
    // At most one current version per kind.
    uniqueIndex('terms_version_current_key')
      .on(table.kind)
      .where(sql`${table.isCurrent}`),
    check('terms_version_kind_check', sql`${table.kind} in (${list(SIGNUP_TERMS_KINDS)})`),
    check('terms_version_version_check', sql`${table.version} >= 1`),
  ],
);

/**
 * The record that an owner accepted the terms and the data-processing terms: which version of
 * each, when, and who. Written when the owner's account exists (the verification of the signup),
 * with the instant the visitor accepted on the form. Append-only: a later acceptance is a new row.
 */
export const termsAcceptance = tenantTable(
  'terms_acceptance',
  {
    userId: uuid('user_id').notNull(),
    termsVersion: integer('terms_version').notNull(),
    dataProcessingVersion: integer('data_processing_version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'terms_acceptance_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'terms_acceptance_user_id_fkey',
      columns: [table.userId],
      foreignColumns: [userAccount.id],
    }),
    check(
      'terms_acceptance_versions_check',
      sql`${table.termsVersion} >= 1 and ${table.dataProcessingVersion} >= 1`,
    ),
  ],
);

/**
 * What an unverified organization carries until its owner follows the emailed link: the owner's
 * address and name, the HASH of the chosen password, and the two acceptances with their versions.
 * There is no account yet on purpose (a signup nobody confirmed must not take an address that
 * somebody else may need: pre-registering an account with a victim's address would let the signer
 * set its password). The verification creates the account from this row and clears the hash.
 *
 * Holds the personal data of a person who has not proved the address is theirs, so the purge
 * removes it with the organization after seven days. Never read by any other module.
 */
export const signupPending = tenantTable(
  'signup_pending',
  {
    ownerEmail: citext('owner_email').notNull(),
    ownerName: text('owner_name').notNull(),
    /** Argon2id PHC string; cleared (null) when the signup is verified. */
    passwordHash: text('password_hash'),
    termsVersion: integer('terms_version').notNull(),
    dataProcessingVersion: integer('data_processing_version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    /** When the verification email was handed to the provider; null while it is still to be sent. */
    verificationSentAt: timestamp('verification_sent_at', { withTimezone: true }),
    sendAttempts: integer('send_attempts').notNull().default(0),
    lastSendAttemptAt: timestamp('last_send_attempt_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'signup_pending_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    // One signup per organization.
    unique('signup_pending_tenant_id_key').on(table.tenantId),
    // An address has at most one signup waiting for its link.
    uniqueIndex('signup_pending_email_key')
      .on(table.ownerEmail)
      .where(sql`${table.verifiedAt} is null`),
    // The password hash lives exactly as long as the signup is unverified.
    check(
      'signup_pending_hash_check',
      sql`(${table.verifiedAt} is null) = (${table.passwordHash} is not null)`,
    ),
    check('signup_pending_attempts_check', sql`${table.sendAttempts} >= 0`),
  ],
);
