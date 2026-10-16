import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { professional } from './staff.js';
import { tenant } from './tenant.js';

/**
 * An explicit assignment of a patient to a professional (authorization, "Explicit patient
 * assignment"): one of the three sources of the care relationship. An owner/admin (or someone
 * with patient administration) creates it; a professional can never assign a patient to
 * themselves. Assignments are ended, not deleted, so the history stays.
 *
 * `professional_id` has its composite foreign key since S1.19; `patient_id` gets its own with the
 * patient table (S1.20).
 */
export const careAssignment = tenantTable(
  'care_assignment',
  {
    patientId: uuid('patient_id').notNull(),
    professionalId: uuid('professional_id').notNull(),
    assignedBy: uuid('assigned_by').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: uuid('removed_by'),
  },
  (table) => [
    foreignKey({
      name: 'care_assignment_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'care_assignment_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    // One live assignment per pair; a removed one can be assigned again later.
    uniqueIndex('care_assignment_live_idx')
      .on(table.tenantId, table.patientId, table.professionalId)
      .where(sql`${table.removedAt} is null`),
    index('care_assignment_patient_idx').on(table.tenantId, table.patientId),
  ],
);

/**
 * "This professional treats this patient": one row per (patient, professional), fed by three
 * sources (design 3.6): appointments with confirmed identity in a qualifying status, encounters,
 * and explicit assignments. `active` is derived and is the ONLY thing row level security reads
 * (`app.clinical_readable`), so access before identity confirmation is impossible by construction.
 *
 * The runtime role cannot write this table at all: only the SECURITY DEFINER functions
 * `app.care_set_assigned` and `app.care_adjust`, called by triggers, change it. Application code
 * therefore cannot fabricate a relationship. Appointment and encounter triggers arrive in Stage 2.
 */
export const careRelationship = tenantTable(
  'care_relationship',
  {
    patientId: uuid('patient_id').notNull(),
    professionalId: uuid('professional_id').notNull(),
    qualifyingAppointments: integer('qualifying_appointments').notNull().default(0),
    encounters: integer('encounters').notNull().default(0),
    assigned: boolean('assigned').notNull().default(false),
    active: boolean('active')
      .notNull()
      .generatedAlwaysAs(sql`qualifying_appointments > 0 or encounters > 0 or assigned`),
  },
  (table) => [
    foreignKey({
      name: 'care_relationship_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'care_relationship_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    uniqueIndex('care_relationship_pair_key').on(
      table.tenantId,
      table.patientId,
      table.professionalId,
    ),
    // The policy asks "does this professional treat this patient": answered by this index.
    index('care_relationship_active_idx')
      .on(table.tenantId, table.professionalId, table.patientId)
      .where(sql`${table.active}`),
  ],
);

export type CareAssignmentRow = typeof careAssignment.$inferSelect;
export type CareRelationshipRow = typeof careRelationship.$inferSelect;
