import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { message } from './notifications.js';
import { professional } from './staff.js';
import { tenant } from './tenant.js';

/**
 * One WhatsApp message the provider accepted, counted against the professional the appointment
 * belongs to (spec "Quotas, usage and integration switches"). The count is the platform's own
 * record for the quota and the bill: it is written when the provider ACCEPTS the message (a
 * refusal costs nothing, and email is never counted), once per message, also in a single-tenant
 * deployment whose subscription billing is off. Counts only: no patient, no text.
 *
 * `period` is the calendar month of `counted_at` in the time zone of the organization, as `YYYY-MM`.
 */
export const whatsappUsageEvent = tenantTable(
  'whatsapp_usage_event',
  {
    messageId: uuid('message_id').notNull(),
    professionalId: uuid('professional_id').notNull(),
    countedAt: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
    period: text('period').notNull(),
    /**
     * A place in the quota is RESERVED when a message is prepared (under a lock, so two messages
     * cannot take the last one) and CONFIRMED when the provider accepts it. A message the
     * provider refuses, or that never goes, RELEASES it: the row stays as the record, and stops
     * counting. Only these two columns can change (judgment day finding C7).
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'whatsapp_usage_event_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'whatsapp_usage_event_message_fkey',
      columns: [table.tenantId, table.messageId],
      foreignColumns: [message.tenantId, message.id],
    }),
    foreignKey({
      name: 'whatsapp_usage_event_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    check('whatsapp_usage_event_period_check', sql`${table.period} ~ '^[0-9]{4}-[0-9]{2}$'`),
    // A message counts once, however many times its acceptance is processed.
    unique('whatsapp_usage_event_tenant_id_message_id_key').on(table.tenantId, table.messageId),
    index('whatsapp_usage_event_professional_idx').on(
      table.tenantId,
      table.professionalId,
      table.period,
    ),
    // The rows the runner's backfill still looks at: neither confirmed nor released. Without it
    // every boot reads the whole table (JD-S3 follow-up). Live reservations match too.
    index('whatsapp_usage_event_unsettled_idx')
      .on(table.tenantId, table.id)
      .where(sql`${table.confirmedAt} is null and ${table.releasedAt} is null`),
  ],
);

export type WhatsappUsageEventRow = typeof whatsappUsageEvent.$inferSelect;

/** The thresholds of the monthly quota at which the owner is told (80% and 100%). */
export const USAGE_ALERT_THRESHOLDS = [80, 100] as const;

/**
 * The owner is told once per professional, month and threshold. The row IS the "already told":
 * the unique key makes a second notification impossible, even if two messages cross the
 * threshold at the same moment.
 */
export const whatsappUsageAlert = tenantTable(
  'whatsapp_usage_alert',
  {
    professionalId: uuid('professional_id').notNull(),
    period: text('period').notNull(),
    threshold: smallint('threshold').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'whatsapp_usage_alert_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'whatsapp_usage_alert_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    check('whatsapp_usage_alert_threshold_check', sql`${table.threshold} in (80, 100)`),
    check('whatsapp_usage_alert_period_check', sql`${table.period} ~ '^[0-9]{4}-[0-9]{2}$'`),
    unique('whatsapp_usage_alert_key').on(
      table.tenantId,
      table.professionalId,
      table.period,
      table.threshold,
    ),
  ],
);

export type WhatsappUsageAlertRow = typeof whatsappUsageAlert.$inferSelect;
