import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { appointmentType } from './scheduling-config.js';
import { slotHold } from './scheduling.js';
import { professional } from './staff.js';
import { tenant } from './tenant.js';

/**
 * A public booking link (online-booking, "Public booking links"). An organization has at most one
 * link of its own (`professional_id` null) and one per professional. The `slug` is what the URL
 * carries and is unique across the platform; regenerating a link replaces its slug, so the old URL
 * stops resolving at once. A link is disabled or regenerated, never deleted.
 *
 * What a visitor may book through a link is chosen here and nowhere else:
 * - a professional appears in the organization page only when their own link is enabled;
 * - `location_ids` limits the locations (empty: every location the professional works at);
 * - `type_ids` lists the appointment types that may be booked online (empty: none, so a link
 *   exposes nothing until someone chooses).
 * The organization-level row carries no types or locations of its own.
 */
export const bookingLink = tenantTable(
  'booking_link',
  {
    professionalId: uuid('professional_id'),
    slug: text('slug').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    locationIds: uuid('location_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    typeIds: uuid('type_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    regeneratedAt: timestamp('regenerated_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'booking_link_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'booking_link_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    check('booking_link_slug_check', sql`${table.slug} ~ '^[a-z0-9]{8,32}$'`),
    // Unique across the platform: the URL names the link, not the organization.
    uniqueIndex('booking_link_slug_key').on(table.slug),
    uniqueIndex('booking_link_organization_key')
      .on(table.tenantId)
      .where(sql`${table.professionalId} is null`),
    uniqueIndex('booking_link_professional_key')
      .on(table.tenantId, table.professionalId)
      .where(sql`${table.professionalId} is not null`),
  ],
);

export type BookingLinkRow = typeof bookingLink.$inferSelect;

/**
 * What a public slot hold was made for. A hold of scheduling is a reserved range and nothing else:
 * it has no type of visit. The booking that finishes it needs one, and the visitor chose it when
 * they chose the time, so it is kept here, server side, instead of being sent back by the page. The
 * link says where the hold came from. A hold is never deleted, and neither is this row.
 */
export const publicHold = tenantTable(
  'public_hold',
  {
    holdId: uuid('hold_id').notNull(),
    appointmentTypeId: uuid('appointment_type_id').notNull(),
    bookingLinkId: uuid('booking_link_id').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'public_hold_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'public_hold_hold_fkey',
      columns: [table.tenantId, table.holdId],
      foreignColumns: [slotHold.tenantId, slotHold.id],
    }),
    foreignKey({
      name: 'public_hold_type_fkey',
      columns: [table.tenantId, table.appointmentTypeId],
      foreignColumns: [appointmentType.tenantId, appointmentType.id],
    }),
    foreignKey({
      name: 'public_hold_link_fkey',
      columns: [table.tenantId, table.bookingLinkId],
      foreignColumns: [bookingLink.tenantId, bookingLink.id],
    }),
    uniqueIndex('public_hold_hold_key').on(table.tenantId, table.holdId),
  ],
);

export type PublicHoldRow = typeof publicHold.$inferSelect;
