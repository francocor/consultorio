import { MESSAGE_CHANNELS } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, text, uuid } from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { patient } from './patients.js';
import { tenant } from './tenant.js';

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/** Where an opt-in comes from: the patient on the booking form, reception for the patient, the patient's own click. */
export const OPT_IN_SOURCES = ['online_booking', 'staff', 'patient_email_link'] as const;

/** Where an opt-out comes from: a keyword on WhatsApp, the link in an email, or reception for the patient. */
export const OPT_OUT_SOURCES = ['whatsapp_keyword', 'email_link', 'staff'] as const;

/**
 * What a patient chose for a channel, as a history: every opt-in and opt-out is a row, and the
 * latest row of a (patient, channel) is the choice in force. Nothing is updated or deleted, so
 * "who recorded it, when and from where" survives every change (spec "Opt-out and consent").
 *
 * - An opt-in is how WhatsApp is allowed at all. Email needs none: it works until the patient opts
 *   out, and an email opt-in only ever means "the patient turned it back on".
 * - `recorded_by` is the staff member for the `staff` source and null when the patient acted.
 * - Staff cannot undo a patient's opt-out: the service refuses it, and only a source in which the
 *   patient acts (the booking form, their own email link) can opt back in.
 */
export const channelPreference = tenantTable(
  'channel_preference',
  {
    patientId: uuid('patient_id').notNull(),
    channel: text('channel').notNull(),
    state: text('state').notNull(),
    source: text('source').notNull(),
    recordedBy: uuid('recorded_by'),
  },
  (table) => [
    foreignKey({
      name: 'channel_preference_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'channel_preference_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    check('channel_preference_channel_check', sql.raw(`"channel" in (${list(MESSAGE_CHANNELS)})`)),
    check(
      'channel_preference_state_source_check',
      sql.raw(
        `("state" = 'opted_in' and "source" in (${list(OPT_IN_SOURCES)})) or ("state" = 'opted_out' and "source" in (${list(OPT_OUT_SOURCES)}))`,
      ),
    ),
    // Staff are named when they record, and only then.
    check(
      'channel_preference_staff_check',
      sql`(${table.source} = 'staff') = (${table.recordedBy} is not null)`,
    ),
    index('channel_preference_current_idx').on(
      table.tenantId,
      table.patientId,
      table.channel,
      table.createdAt,
    ),
  ],
);

export type ChannelPreferenceRow = typeof channelPreference.$inferSelect;
