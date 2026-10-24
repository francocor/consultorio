import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The platform table `demo_outbox` (Stage 5 integration, task 5.48): where the email sender of the
 * demo organizations keeps what it captured, so a demo can be walked through without a mailbox (the
 * portal sign-in code is read in the provider console). It is a platform table on purpose, like the
 * simulators' and the operator note: the column is `target_tenant_id` (not `tenant_id`), so it is
 * not a tenant table and carries no row level security. Only the demo email sender inserts and only
 * the provider console reads (both with the application role); nothing updates or deletes a row,
 * and `app.demo_reset` removes the rows of the organization it resets (migration 0590).
 *
 * What it holds is what a demo organization sent: fictitious addresses, and texts that never carry
 * clinical content (the notices say nothing clinical by rule). It is never filled for a customer.
 */
export const demoOutbox = pgTable(
  'demo_outbox',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    /** The demo organization the message is about. No foreign key: the reset removes the rows itself. */
    targetTenantId: uuid('target_tenant_id').notNull(),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('demo_outbox_tenant_idx').on(table.targetTenantId, table.createdAt, table.id)],
);

export type DemoOutboxRow = typeof demoOutbox.$inferSelect;
