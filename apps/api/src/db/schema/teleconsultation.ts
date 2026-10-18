import {
  MANUAL_VIDEO_LINK_MAX_LENGTH,
  VIDEO_CLOSE_REASONS,
  VIDEO_PENDING_REASONS,
  VIDEO_SESSION_STATUSES,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { check, foreignKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { appointment } from './scheduling.js';
import { tenant } from './tenant.js';

const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '));

/**
 * The video side of a virtual appointment: whether it has a link, where the link came from, and
 * whether the patient opened it. One row per appointment, created with the appointment and kept
 * after it (a session is closed, never deleted).
 *
 * The room name does not live here: it stays in `appointment.video_room`, the one place that says
 * which provider room belongs to the appointment now. A new room (reschedule, reassignment) resets
 * the opening marks and the manual link, because they belonged to the old one.
 *
 * - `ready`: a platform join address works inside the join window.
 * - `link_pending`: no link yet; `pending_reason` says why (the provider is being asked, the
 *   integration is off, the provider is unavailable or failed). Reception and the professional see
 *   an alert, and can attach a manual link.
 * - `closed`: nobody can join any more; `close_reason` says why.
 */
export const videoSession = tenantTable(
  'video_session',
  {
    appointmentId: uuid('appointment_id').notNull(),
    status: text('status').notNull().default('link_pending'),
    pendingReason: text('pending_reason'),
    closeReason: text('close_reason'),
    /** The adapter that created the room (`local`, `fake`); null for a session with a manual link. */
    provider: text('provider'),
    /**
     * LEGACY, plaintext: an address attached before the link was encrypted (judgment day finding
     * C9). Nothing writes it any more; it is read while it exists, and replaced the next time the
     * link is followed. A manual link can carry a passcode, so it does not rest in plaintext.
     */
    manualLink: text('manual_link'),
    /** The https address a person attached, encrypted with the key of the organization. */
    manualLinkEnc: bytea('manual_link_enc'),
    /** Administrative: the patient opened the platform address inside the join window. */
    firstOpenedAt: timestamp('first_opened_at', { withTimezone: true }),
    lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'video_session_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'video_session_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    unique('video_session_appointment_key').on(table.tenantId, table.appointmentId),
    check('video_session_status_check', sql`${table.status} in (${list(VIDEO_SESSION_STATUSES)})`),
    check(
      'video_session_pending_reason_check',
      sql`${table.pendingReason} is null or ${table.pendingReason} in (${list(VIDEO_PENDING_REASONS)})`,
    ),
    check(
      'video_session_close_reason_check',
      sql`${table.closeReason} is null or ${table.closeReason} in (${list(VIDEO_CLOSE_REASONS)})`,
    ),
    // A pending session says why, a closed one says why, and a ready one needs neither.
    check(
      'video_session_reason_matches_status_check',
      sql`(${table.status} = 'link_pending') = (${table.pendingReason} is not null)
        and (${table.status} = 'closed') = (${table.closeReason} is not null)`,
    ),
    check(
      'video_session_opened_order_check',
      sql`${table.lastOpenedAt} is null
        or (${table.firstOpenedAt} is not null and ${table.lastOpenedAt} >= ${table.firstOpenedAt})`,
    ),
    check(
      'video_session_manual_link_check',
      sql`${table.manualLink} is null or length(${table.manualLink}) <= ${sql.raw(String(MANUAL_VIDEO_LINK_MAX_LENGTH))}`,
    ),
  ],
);

export type VideoSessionRow = typeof videoSession.$inferSelect;
