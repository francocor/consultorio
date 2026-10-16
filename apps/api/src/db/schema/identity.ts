import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { tenant } from './tenant.js';

/** Case-insensitive text (PostgreSQL `citext`): emails compare equal whatever their case. */
const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/**
 * A person who signs in to the staff application. Global on purpose: one account may work in
 * several organizations through `membership`. It has no `tenant_id`, so it is isolated by its own
 * row level security policies (migration 0007), not by `tenant_isolation`:
 *
 * - a transaction sees an account if it IS that user (`app.user_id`) or the account has a
 *   membership in the transaction's tenant, so tenant B never sees tenant A's staff;
 * - a transaction can only INSERT or UPDATE the account it acts as, so an administrator cannot
 *   change a colleague's password hash or lock counters (an admin can only trigger a reset email);
 * - the login lookup function `app.lookup_user_for_login(email)` is the only path that finds an
 *   account before any user or tenant is known, and it returns a minimal set of columns;
 * - the runtime role cannot DELETE accounts.
 */
export const userAccount = pgTable(
  'user_account',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    email: citext('email').notNull(),
    /** Argon2id PHC string. Never logged, never returned by an endpoint. */
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    /** Field-encrypted TOTP secret (envelope encryption, bound to this row). Null until enrollment starts. */
    totpSecretEnc: bytea('totp_secret_enc'),
    /**
     * A secret being enrolled or replaced, not yet confirmed. The active secret keeps working until
     * the user proves the new one with a code, so abandoning a replacement never locks them out.
     */
    totpPendingEnc: bytea('totp_pending_enc'),
    /** Tenant whose data key encrypted the secret (an account may sign in to several tenants). */
    totpTenantId: uuid('totp_tenant_id'),
    /** Set when the first code was verified; until then the enrollment is pending. */
    totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),
    /** Last accepted TOTP time step: a code of the same or an earlier step is a replay. */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    /** Starts the 7-day grace period for mandatory two-factor authentication. */
    firstSignInAt: timestamp('first_sign_in_at', { withTimezone: true }),
    /** Consecutive failures: wrong password or wrong second-factor code. */
    failedLogins: integer('failed_logins').notNull().default(0),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true }),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('user_account_email_key').on(table.email),
    check('user_account_failed_logins_check', sql`${table.failedLogins} >= 0`),
  ],
);

export type UserAccountRow = typeof userAccount.$inferSelect;

/** Roles a staff membership can hold. `patient` is deliberately absent: patients have no `user`. */
const STAFF_ROLES_SQL = `array['owner','admin','professional','reception']::text[]`;

/** What a user may do in one organization. Never deleted: deactivation keeps the history intact. */
export const membership = tenantTable(
  'membership',
  {
    // Declared inline in the migration (see 0007): `user_account` is row level secured.
    userId: uuid('user_id').notNull(),
    roles: text('roles').array().notNull(),
    status: text('status').notNull().default('active'),
  },
  (table) => [
    foreignKey({
      name: 'membership_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    unique('membership_tenant_id_user_id_key').on(table.tenantId, table.userId),
    check(
      'membership_roles_check',
      sql`cardinality(${table.roles}) > 0 and ${table.roles} <@ ${sql.raw(STAFF_ROLES_SQL)}`,
    ),
    check('membership_status_check', sql`${table.status} in ('active', 'deactivated')`),
  ],
);

export type MembershipRow = typeof membership.$inferSelect;

/**
 * A server-side session. Only the SHA-256 of the opaque token is stored. `tenant_id` IS the
 * session's active tenant: the session is only visible on that tenant's host, so a cookie
 * replayed on another host finds no session and gets 401.
 */
export const session = tenantTable(
  'session',
  {
    userId: uuid('user_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** `full`, or `two_factor_enrollment` (only the enrollment endpoints work). */
    scope: text('scope').notNull().default('full'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Absolute lifetime. The idle timeout is derived from `last_seen_at`. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    foreignKey({
      name: 'session_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'session_membership_fkey',
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    uniqueIndex('session_token_hash_key').on(table.tokenHash),
    index('session_user_idx')
      .on(table.tenantId, table.userId)
      .where(sql`${table.revokedAt} is null`),
    check('session_scope_check', sql`${table.scope} in ('full', 'two_factor_enrollment')`),
  ],
);

export type SessionRow = typeof session.$inferSelect;

/**
 * The step between a correct password and the second factor: 5 minutes, 5 attempts. The raw
 * challenge id is handed to the client once; only its hash is stored.
 */
export const loginChallenge = tenantTable(
  'login_challenge',
  {
    userId: uuid('user_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'login_challenge_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'login_challenge_membership_fkey',
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    uniqueIndex('login_challenge_token_hash_key').on(table.tokenHash),
    check('login_challenge_attempts_check', sql`${table.attempts} >= 0`),
  ],
);

export type LoginChallengeRow = typeof loginChallenge.$inferSelect;

/** Single-use two-factor recovery codes of a user. Only hashes are stored. */
export const recoveryCode = pgTable(
  'recovery_code',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    userId: uuid('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('recovery_code_user_idx').on(table.userId)],
);

export type RecoveryCodeRow = typeof recoveryCode.$inferSelect;
