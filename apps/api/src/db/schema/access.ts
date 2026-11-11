import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { membership } from './identity.js';
import { location, tenant } from './tenant.js';

/** Free-form JSON object columns. Their shapes are validated in the API. */
type JsonObject = Record<string, unknown>;

/**
 * A non-clinical permission an owner or admin handed to one member (authorization, "Grantable
 * non-clinical permissions"). Effective permissions are the role's plus the live grants that are
 * inside `GRANTABLE`. A grant is ended, never deleted, so the history stays.
 *
 * `CHECK (permission NOT LIKE 'clinical.%')` is the database half of the hard rule: even code that
 * skipped the catalog could not store a clinical permission as a grant.
 */
export const permissionGrant = tenantTable(
  'permission_grant',
  {
    membershipId: uuid('membership_id').notNull(),
    permission: text('permission').notNull(),
    /** Extra narrowing, for example `{ "professionalIds": [...] }` for a delegated calendar. */
    scope: jsonb('scope').$type<JsonObject>().notNull().default({}),
    grantedBy: uuid('granted_by').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
  },
  (table) => [
    foreignKey({
      name: 'permission_grant_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'permission_grant_membership_fkey',
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    check('permission_grant_not_clinical_check', sql`${table.permission} not like 'clinical.%'`),
    check('permission_grant_format_check', sql`${table.permission} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    uniqueIndex('permission_grant_live_idx')
      .on(table.tenantId, table.membershipId, table.permission)
      .where(sql`${table.revokedAt} is null`),
    index('permission_grant_membership_idx').on(table.tenantId, table.membershipId),
  ],
);

export type PermissionGrantRow = typeof permissionGrant.$inferSelect;

/**
 * The locations a member works at. Reception and other non-professional staff see and operate the
 * schedule, check-in and cash register of their locations only; owners and admins see all of them.
 * An assignment is ended (`removed_at`), never deleted.
 */
export const membershipLocation = tenantTable(
  'membership_location',
  {
    membershipId: uuid('membership_id').notNull(),
    locationId: uuid('location_id').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'membership_location_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'membership_location_membership_fkey',
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    foreignKey({
      name: 'membership_location_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    uniqueIndex('membership_location_live_idx')
      .on(table.tenantId, table.membershipId, table.locationId)
      .where(sql`${table.removedAt} is null`),
    index('membership_location_location_idx').on(table.tenantId, table.locationId),
  ],
);

export type MembershipLocationRow = typeof membershipLocation.$inferSelect;
