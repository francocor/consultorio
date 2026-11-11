import { sql } from 'drizzle-orm';
import { check, foreignKey, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { location, tenant } from './tenant.js';

/** The kinds of reception worklist item (scheduling, "Reception worklist"). No others exist. */
export const WORKLIST_KINDS = [
  'pending_approval',
  'identity_review',
  'reminder_not_sent',
  'reminder_not_delivered',
  'reply_to_review',
  'waitlist_manual_contact',
  // An invoice a person has to look at (invoicing, JD-S4 R1-C3 and C8).
  'invoice_attention',
] as const;

const KIND_LIST = WORKLIST_KINDS.map((kind) => `'${kind}'`).join(', ');

/**
 * The one reception queue (design 3.6, F14): everything that needs a person, whichever capability
 * found it. Items carry administrative data only; any detail (for example the differences between
 * what a booking submitted and what the record holds) is encrypted. An item is resolved or
 * dismissed with a recorded actor and time, and never deleted.
 *
 * `subject_id` points at an appointment, a waitlist entry, an inbound message or an invoice, so it has no
 * foreign key (the subject lives in another capability). At most one item per kind and subject is
 * open at a time: opening it again is a no-op.
 */
export const worklistItem = tenantTable(
  'worklist_item',
  {
    kind: text('kind').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    /** Null for an item that belongs to the whole organization. */
    locationId: uuid('location_id'),
    status: text('status').notNull().default('open'),
    detailEnc: bytea('detail_enc'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** How it ended: the action taken, as a code (for example `identity_confirmed`). */
    resolution: text('resolution'),
  },
  (table) => [
    foreignKey({
      name: 'worklist_item_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'worklist_item_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check('worklist_item_kind_check', sql.raw(`"kind" in (${KIND_LIST})`)),
    check(
      'worklist_item_subject_type_check',
      sql`${table.subjectType} in ('appointment', 'waitlist_entry', 'inbound_message', 'invoice')`,
    ),
    check('worklist_item_status_check', sql`${table.status} in ('open', 'resolved', 'dismissed')`),
    check(
      'worklist_item_resolution_check',
      sql`(${table.status} = 'open' and ${table.resolvedAt} is null and ${table.resolvedBy} is null)
        or (${table.status} <> 'open' and ${table.resolvedAt} is not null and ${table.resolvedBy} is not null)`,
    ),
    uniqueIndex('worklist_item_open_key')
      .on(table.tenantId, table.kind, table.subjectType, table.subjectId)
      .where(sql`${table.status} = 'open'`),
    index('worklist_item_queue_idx')
      .on(table.tenantId, table.status, table.createdAt)
      .where(sql`${table.status} = 'open'`),
    index('worklist_item_subject_idx').on(table.tenantId, table.subjectType, table.subjectId),
  ],
);

export type WorklistItemRow = typeof worklistItem.$inferSelect;
