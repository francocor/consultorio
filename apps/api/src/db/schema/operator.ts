import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, citext, tenantTable } from './_helpers.js';
import { tenant } from './tenant.js';

/**
 * A person who runs the platform. NOT a tenant user: no membership, no role in any organization,
 * and a separate sign-in on the platform host only. These tables belong to the operator console:
 * the application role cannot read them (see migration 0017).
 *
 * The second factor is mandatory and has no grace period, so an operator row is born with its
 * TOTP secret. The secret is encrypted with a per-operator data key that the key service wraps.
 */
export const operatorUser = pgTable(
  'operator_user',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    email: citext('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    totpDekWrapped: bytea('totp_dek_wrapped').notNull(),
    totpSecretEnc: bytea('totp_secret_enc').notNull(),
    /** The last time step accepted, so a code works once even inside its window. */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    failedLogins: integer('failed_logins').notNull().default(0),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('operator_user_email_key').on(table.email),
    check('operator_user_status_check', sql`${table.status} in ('active', 'disabled')`),
    check('operator_user_failed_logins_check', sql`${table.failedLogins} >= 0`),
  ],
);

/** An operator session. Only the SHA-256 of the cookie token is stored, like staff sessions. */
export const operatorSession = pgTable(
  'operator_session',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    operatorId: uuid('operator_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    foreignKey({
      name: 'operator_session_operator_id_fkey',
      columns: [table.operatorId],
      foreignColumns: [operatorUser.id],
    }),
    uniqueIndex('operator_session_token_hash_key').on(table.tokenHash),
    index('operator_session_operator_idx').on(table.operatorId),
  ],
);

/**
 * The audit trail of the platform itself: operator sign-ins, tenant creation, demo resets and
 * every use (or refused use) of a support grant. One global chain, append-only and sealed with the
 * same hash chain as the tenant trails. It has no `tenant_id` column on purpose: the tenant an
 * action is about is `target_tenant_id`, and rows are not filtered by tenant isolation.
 */
export const platformAuditEvent = pgTable(
  'platform_audit_event',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    seq: bigint('seq', { mode: 'number' }),
    /** Null when nobody was identified (a failed sign-in for an unknown address). */
    operatorId: uuid('operator_id'),
    targetTenantId: uuid('target_tenant_id'),
    action: text('action').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    prevHash: text('prev_hash'),
    hash: text('hash'),
  },
  (table) => [
    uniqueIndex('platform_audit_event_seq_key').on(table.seq),
    index('platform_audit_event_time_idx').on(table.occurredAt),
    index('platform_audit_event_tenant_idx').on(table.targetTenantId, table.occurredAt),
    check('platform_audit_event_outcome_check', sql`${table.outcome} in ('allow', 'deny')`),
    check(
      'platform_audit_event_seal_check',
      sql`(${table.seq} is null and ${table.prevHash} is null and ${table.hash} is null)
        or (${table.seq} is not null and ${table.prevHash} is not null and ${table.hash} is not null)`,
    ),
  ],
);

/**
 * Support access granted BY THE ORGANIZATION to the platform operator, for a stated reason and a
 * limited time. It opens administrative data only (the organization's configuration): never a
 * clinical or patient table, which the operator's database role cannot read at all. A grant ends
 * by itself when it expires, and the organization can revoke it at any moment.
 */
export const supportGrant = tenantTable(
  'support_grant',
  {
    /** What the grant covers. Only `administrative` exists; clinical content is never grantable. */
    scope: text('scope').notNull().default('administrative'),
    reason: text('reason').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    grantedBy: uuid('granted_by').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
  },
  (table) => [
    foreignKey({
      name: 'support_grant_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    check('support_grant_scope_check', sql`${table.scope} = 'administrative'`),
    check('support_grant_window_check', sql`${table.expiresAt} > ${table.startsAt}`),
    check(
      'support_grant_max_window_check',
      sql`${table.expiresAt} <= ${table.startsAt} + interval '7 days'`,
    ),
    index('support_grant_tenant_idx').on(table.tenantId, table.expiresAt),
  ],
);

export type OperatorUserRow = typeof operatorUser.$inferSelect;
export type SupportGrantRow = typeof supportGrant.$inferSelect;
