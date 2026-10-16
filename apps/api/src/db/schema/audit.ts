import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  inet,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenant } from './tenant.js';

/**
 * Append-only audit trail (audit-log, ADR-005).
 *
 * The migration makes this a table PARTITIONED BY RANGE (occurred_at), one partition per month
 * (`app.ensure_audit_partitions`). drizzle-kit cannot express partitioning, so the generated
 * CREATE TABLE is edited by hand in migration 0004; the columns here are the source of truth for
 * the typed queries.
 *
 * - `app_rw` has INSERT and SELECT only. Triggers reject DELETE and every UPDATE except the one
 *   that fills `seq`, `prev_hash` and `hash` once, by the `audit_sealer` role.
 * - The row is written in the business transaction (fail-closed). Sealing is asynchronous.
 * - `metadata` never holds clinical content; the writer validates it against the contracts schema.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id')
      .notNull()
      .default(sql`app.uuid_v7()`),
    tenantId: uuid('tenant_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Position in the tenant's hash chain. Null until sealed. */
    seq: bigint('seq', { mode: 'number' }),
    /** Null for system actions and unauthenticated attempts. */
    actorUserId: uuid('actor_user_id'),
    actingRole: text('acting_role'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    patientId: uuid('patient_id'),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    prevHash: text('prev_hash'),
    hash: text('hash'),
  },
  (table) => [
    // A partitioned table's primary key must contain the partition key.
    primaryKey({ columns: [table.tenantId, table.occurredAt, table.id] }),
    foreignKey({
      name: 'audit_event_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    index('audit_event_tenant_time_idx').on(table.tenantId, table.occurredAt.desc()),
    index('audit_event_tenant_patient_idx')
      .on(table.tenantId, table.patientId, table.occurredAt.desc())
      .where(sql`${table.patientId} is not null`),
    index('audit_event_tenant_actor_idx')
      .on(table.tenantId, table.actorUserId, table.occurredAt.desc())
      .where(sql`${table.actorUserId} is not null`),
    // The sealer walks unsealed rows in (occurred_at, id) order.
    index('audit_event_unsealed_idx')
      .on(table.tenantId, table.occurredAt, table.id)
      .where(sql`${table.seq} is null`),
    // ... and continues from the last sealed row.
    index('audit_event_sealed_idx')
      .on(table.tenantId, table.seq.desc())
      .where(sql`${table.seq} is not null`),
    check('audit_event_outcome_check', sql`${table.outcome} in ('allow', 'deny')`),
    check(
      'audit_event_seal_check',
      sql`(${table.seq} is null and ${table.prevHash} is null and ${table.hash} is null)
        or (${table.seq} is not null and ${table.prevHash} is not null and ${table.hash} is not null)`,
    ),
  ],
);

export type AuditEventRow = typeof auditEvent.$inferSelect;
