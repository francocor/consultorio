import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Tx } from '../../src/platform/db/tenant-context.js';

import {
  insertAppointmentRow,
  insertLocation,
  insertMembership,
  insertPatient,
  insertProfessional,
  insertUser,
  nextVersion,
  returningId,
  unique,
  type TenantTableFixture,
} from './fixture-helpers.js';

export { unique, type TenantTableFixture };

/**
 * Tables that hold clinical content. Their rows are only visible to a health professional's
 * transaction, so the isolation suite reads them acting as the professional who wrote them.
 */
export const CLINICAL_TABLES: ReadonlySet<string> = new Set([
  'anamnesis',
  'encounter',
  'clinical_note',
  'note_version',
  'addendum',
  // No content, but only a professional reads it (JD-S2 S7).
  'clinical_footprint',
]);

/** Row id -> professional who authored it, for the clinical fixtures below. */
export const CLINICAL_AUTHORS = new Map<string, string>();

/** Runs `fn` acting as a health professional (the clinical policies and triggers need one). */
async function actingAs<T>(tx: Tx, professionalId: string, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`select set_config('app.professional_id', ${professionalId}, true)`);
  // No `finally`: after an error the transaction is aborted and the original error must surface.
  const result = await fn();
  await tx.execute(sql`select set_config('app.professional_id', '', true)`);
  return result;
}

/** An encounter written by `authorId` for a new patient; returns both ids. */
async function insertEncounter(
  tx: Tx,
  tenantId: string,
  authorId: string,
  patientId?: string,
): Promise<{ encounterId: string; patientId: string }> {
  const patient = patientId ?? (await insertPatient(tx, tenantId));
  const encounterId = await actingAs(tx, authorId, () =>
    returningId(
      tx,
      sql`INSERT INTO encounter (tenant_id, patient_id, author_professional_id, template_kind)
            VALUES (${tenantId}, ${patient}, ${authorId}, 'general') RETURNING id`,
    ),
  );
  return { encounterId, patientId: patient };
}

/** The draft note of an encounter, written by `authorId`. Overrides replace foreign key columns. */
async function insertNote(
  tx: Tx,
  tenantId: string,
  opened: { encounterId: string; patientId: string },
  authorId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  const noteAuthor = overrides?.['author_professional_id'] ?? authorId;
  return actingAs(tx, noteAuthor, () =>
    returningId(
      tx,
      sql`INSERT INTO clinical_note (tenant_id, encounter_id, patient_id, author_professional_id, template_kind, template_version)
            VALUES (${tenantId}, ${overrides?.['encounter_id'] ?? opened.encounterId}, ${overrides?.['patient_id'] ?? opened.patientId}, ${noteAuthor}, 'general', 1)
            RETURNING id`,
    ),
  );
}

async function insertVersion(
  tx: Tx,
  tenantId: string,
  note: { noteId: string; patientId: string },
  authorId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  const versionAuthor = overrides?.['author_professional_id'] ?? authorId;
  return actingAs(tx, versionAuthor, () =>
    returningId(
      tx,
      sql`INSERT INTO note_version (tenant_id, note_id, patient_id, author_professional_id, visibility,
                                    template_kind, template_version, version_no, content_enc, content_hash)
            VALUES (${tenantId}, ${overrides?.['note_id'] ?? note.noteId}, ${overrides?.['patient_id'] ?? note.patientId},
                    ${versionAuthor}, 'default', 'general', 1, 1, ${Buffer.from([1])}, ${'b'.repeat(64)})
            RETURNING id`,
    ),
  );
}

const CORE_FIXTURES: Record<string, TenantTableFixture> = {
  care_assignment: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO care_assignment (tenant_id, patient_id, professional_id, assigned_by)
              VALUES (${tenantId}, ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))}, ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))}, ${randomUUID()})
              RETURNING id`,
      ),
  },
  care_relationship: {
    // The runtime role cannot write this table: the relationship appears through an assignment.
    insert: async (tx, tenantId, overrides) => {
      const patientId = overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId));
      await tx.execute(
        sql`INSERT INTO care_assignment (tenant_id, patient_id, professional_id, assigned_by)
              VALUES (${tenantId}, ${patientId}, ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))}, ${randomUUID()})`,
      );
      return returningId(tx, sql`SELECT id FROM care_relationship WHERE patient_id = ${patientId}`);
    },
  },
  action_token: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO action_token (tenant_id, kind, token_hash, subject_id, expires_at)
              VALUES (${tenantId}, 'password_reset', ${randomUUID()}, ${randomUUID()}, now() + interval '30 minutes')
              RETURNING id`,
      ),
  },
  membership: {
    insert: async (tx, tenantId) => insertMembership(tx, tenantId, await insertUser(tx)),
  },
  session: {
    insert: async (tx, tenantId, overrides) => {
      const userId = await insertUser(tx);
      const membershipId =
        overrides?.['membership_id'] ?? (await insertMembership(tx, tenantId, userId));
      return returningId(
        tx,
        sql`INSERT INTO session (tenant_id, user_id, membership_id, token_hash, expires_at)
              VALUES (${tenantId}, ${userId}, ${membershipId}, ${randomUUID()}, now() + interval '1 day')
              RETURNING id`,
      );
    },
  },
  login_challenge: {
    insert: async (tx, tenantId, overrides) => {
      const userId = await insertUser(tx);
      const membershipId =
        overrides?.['membership_id'] ?? (await insertMembership(tx, tenantId, userId));
      return returningId(
        tx,
        sql`INSERT INTO login_challenge (tenant_id, user_id, membership_id, token_hash, expires_at)
              VALUES (${tenantId}, ${userId}, ${membershipId}, ${randomUUID()}, now() + interval '5 minutes')
              RETURNING id`,
      );
    },
  },
  audit_event: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO audit_event (tenant_id, action, outcome)
              VALUES (${tenantId}, 'access.denied', 'deny')
              RETURNING id`,
      ),
  },
  job_execution: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO job_execution (tenant_id, queue, job_id)
              VALUES (${tenantId}, 'test.echo', ${randomUUID()})
              RETURNING id`,
      ),
  },
  tenant_key: {
    // Retired, so the one-active-key rule does not stop a second fixture row for the same tenant.
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO tenant_key (tenant_id, purpose, version, kek_id, dek_wrapped, status)
              VALUES (${tenantId}, 'tenant-dek', ${nextVersion()}, 'test', ${Buffer.from([0])}, 'retired')
              RETURNING id`,
      ),
  },
  location: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO location (tenant_id, name, time_zone)
              VALUES (${tenantId}, ${unique('Location')}, 'America/Argentina/Buenos_Aires')
              RETURNING id`,
      ),
  },
  patient: {
    insert: (tx, tenantId) => insertPatient(tx, tenantId),
  },
  patient_version: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO patient_version (tenant_id, patient_id, version, snapshot)
              VALUES (${tenantId}, ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))}, 1, '{}'::jsonb)
              RETURNING id`,
      ),
  },
  patient_representative: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO patient_representative (tenant_id, patient_id, full_name, relation, phone, majority_review_on)
              VALUES (${tenantId}, ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))}, 'Rosa', 'mother', '1144445555', '2030-01-01')
              RETURNING id`,
      ),
  },
  payer_plan: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO payer_plan (tenant_id, custom_name, plan_name)
              VALUES (${tenantId}, ${unique('Obra social')}, 'Plan')
              RETURNING id`,
      ),
  },
  patient_coverage: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO patient_coverage (tenant_id, patient_id, payer_plan_id, member_number)
              VALUES (${tenantId},
                      ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                      ${overrides?.['payer_plan_id'] ?? (await returningId(tx, sql`INSERT INTO payer_plan (tenant_id, custom_name) VALUES (${tenantId}, ${unique('Prepaga')}) RETURNING id`))},
                      '12345')
              RETURNING id`,
      ),
  },
  data_processing_consent: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO data_processing_consent (tenant_id, patient_id, text_key, text_version, recorded_by)
              VALUES (${tenantId}, ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))}, 'consent.data_processing.ar', '1', ${randomUUID()})
              RETURNING id`,
      ),
  },
  patient_rights_request: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO patient_rights_request (tenant_id, patient_id, kind, requested_by)
              VALUES (${tenantId}, ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))}, 'access', ${randomUUID()})
              RETURNING id`,
      ),
  },
  support_grant: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO support_grant (tenant_id, reason, expires_at, granted_by)
              VALUES (${tenantId}, 'Ayuda con la configuración', now() + interval '1 hour', ${randomUUID()})
              RETURNING id`,
      ),
  },
  encounter: {
    insert: async (tx, tenantId, overrides) => {
      const authorId =
        overrides?.['author_professional_id'] ?? (await insertProfessional(tx, tenantId));
      const patientId = overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId));
      const id = await actingAs(tx, authorId, () =>
        returningId(
          tx,
          sql`INSERT INTO encounter (tenant_id, patient_id, author_professional_id, template_kind, appointment_id)
                VALUES (${tenantId}, ${patientId}, ${authorId}, 'general', ${overrides?.['appointment_id'] ?? null}) RETURNING id`,
        ),
      );
      CLINICAL_AUTHORS.set(id, authorId);
      return id;
    },
  },
  clinical_footprint: {
    // The runtime role cannot write this table: the footprint appears with the first note.
    insert: async (tx, tenantId, overrides) => {
      const authorId = await insertProfessional(tx, tenantId);
      const patientId = overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId));
      const opened = await insertEncounter(tx, tenantId, authorId, patientId);
      await insertNote(tx, tenantId, opened, authorId);
      // Only a professional reads the footprint.
      return actingAs(tx, authorId, () =>
        returningId(tx, sql`SELECT id FROM clinical_footprint WHERE patient_id = ${patientId}`),
      );
    },
  },
  clinical_note: {
    insert: async (tx, tenantId, overrides) => {
      const authorId = await insertProfessional(tx, tenantId);
      const opened = await insertEncounter(tx, tenantId, authorId);
      const id = await insertNote(tx, tenantId, opened, authorId, overrides);
      CLINICAL_AUTHORS.set(id, overrides?.['author_professional_id'] ?? authorId);
      return id;
    },
  },
  note_version: {
    insert: async (tx, tenantId, overrides) => {
      const authorId = await insertProfessional(tx, tenantId);
      const opened = await insertEncounter(tx, tenantId, authorId);
      const noteId = await insertNote(tx, tenantId, opened, authorId);
      const id = await insertVersion(
        tx,
        tenantId,
        { noteId, patientId: opened.patientId },
        authorId,
        overrides,
      );
      CLINICAL_AUTHORS.set(id, overrides?.['author_professional_id'] ?? authorId);
      return id;
    },
  },
  addendum: {
    insert: async (tx, tenantId, overrides) => {
      const authorId = await insertProfessional(tx, tenantId);
      const opened = await insertEncounter(tx, tenantId, authorId);
      const noteId = await insertNote(tx, tenantId, opened, authorId);
      await insertVersion(tx, tenantId, { noteId, patientId: opened.patientId }, authorId);
      await actingAs(tx, authorId, () =>
        tx.execute(
          sql`UPDATE clinical_note SET status = 'signed', signed_at = now(), draft_content_enc = NULL WHERE id = ${noteId}`,
        ),
      );
      const actor = overrides?.['author_professional_id'] ?? authorId;
      const id = await actingAs(tx, actor, () =>
        returningId(
          tx,
          sql`INSERT INTO addendum (tenant_id, note_id, patient_id, author_professional_id, visibility,
                                    template_kind, kind, reason_enc, content_enc)
                VALUES (${tenantId}, ${overrides?.['note_id'] ?? noteId}, ${overrides?.['patient_id'] ?? opened.patientId},
                        ${actor}, 'default', 'general', 'correction', ${Buffer.from([1])}, ${Buffer.from([1])})
                RETURNING id`,
        ),
      );
      CLINICAL_AUTHORS.set(id, actor);
      return id;
    },
  },
  anamnesis: {
    // The clinical policies read the professional of the transaction, so the fixture acts as the author.
    insert: async (tx, tenantId, overrides) => {
      const authorId =
        overrides?.['author_professional_id'] ?? (await insertProfessional(tx, tenantId));
      await tx.execute(sql`select set_config('app.professional_id', ${authorId}, true)`);
      const id = await returningId(
        tx,
        sql`INSERT INTO anamnesis (tenant_id, patient_id, version, author_professional_id, content_enc)
              VALUES (${tenantId}, ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))}, 1, ${authorId}, '\\x00'::bytea)
              RETURNING id`,
      );
      await tx.execute(sql`select set_config('app.professional_id', '', true)`);
      CLINICAL_AUTHORS.set(id, authorId);
      return id;
    },
  },
  document: {
    // An administrative document: visible to a plain transaction, so the generic suite can read it.
    // The clinical restriction has its own tests (documents-schema.test.ts).
    insert: async (tx, tenantId, overrides) => {
      const id = randomUUID();
      return returningId(
        tx,
        sql`INSERT INTO document (id, tenant_id, patient_id, category, classification, original_name,
                                  declared_content_type, size_bytes, object_key, uploaded_by,
                                  author_professional_id, replaces_document_id, duplicate_of_id,
                                  appointment_id, encounter_id)
              VALUES (${id}, ${tenantId}, ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                      'id_copy', 'administrative', 'dni.pdf', 'application/pdf', 1000,
                      ${`t/${tenantId}/quarantine/${id}`}, ${randomUUID()},
                      ${overrides?.['author_professional_id'] ?? null},
                      ${overrides?.['replaces_document_id'] ?? null},
                      ${overrides?.['duplicate_of_id'] ?? null},
                      ${overrides?.['appointment_id'] ?? null},
                      ${overrides?.['encounter_id'] ?? null})
              RETURNING id`,
      );
    },
  },
  professional: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO professional (tenant_id, membership_id, specialties)
              VALUES (${tenantId}, ${overrides?.['membership_id'] ?? (await insertMembership(tx, tenantId, await insertUser(tx)))}, ARRAY['general'])
              RETURNING id`,
      ),
  },
  professional_hours: {
    insert: async (tx, tenantId, overrides) => {
      const professionalId =
        overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId));
      const locationId =
        overrides?.['location_id'] ??
        (await returningId(
          tx,
          sql`INSERT INTO location (tenant_id, name, time_zone)
                VALUES (${tenantId}, ${unique('Location')}, 'America/Argentina/Buenos_Aires')
                RETURNING id`,
        ));
      return returningId(
        tx,
        sql`INSERT INTO professional_hours (tenant_id, professional_id, location_id, weekday, start_minute, end_minute)
              VALUES (${tenantId}, ${professionalId}, ${locationId}, 1, 540, 780)
              RETURNING id`,
      );
    },
  },
  permission_grant: {
    insert: async (tx, tenantId, overrides) => {
      const membershipId =
        overrides?.['membership_id'] ??
        (await insertMembership(tx, tenantId, await insertUser(tx)));
      return returningId(
        tx,
        sql`INSERT INTO permission_grant (tenant_id, membership_id, permission, granted_by)
              VALUES (${tenantId}, ${membershipId}, 'cash.operate', ${randomUUID()})
              RETURNING id`,
      );
    },
  },
  membership_location: {
    insert: async (tx, tenantId, overrides) => {
      const membershipId =
        overrides?.['membership_id'] ??
        (await insertMembership(tx, tenantId, await insertUser(tx)));
      const locationId =
        overrides?.['location_id'] ??
        (await returningId(
          tx,
          sql`INSERT INTO location (tenant_id, name, time_zone)
                VALUES (${tenantId}, ${unique('Location')}, 'America/Argentina/Buenos_Aires')
                RETURNING id`,
        ));
      return returningId(
        tx,
        sql`INSERT INTO membership_location (tenant_id, membership_id, location_id)
              VALUES (${tenantId}, ${membershipId}, ${locationId})
              RETURNING id`,
      );
    },
  },
  appointment_type: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
              VALUES (${tenantId}, ${unique('Consulta')}, 30)
              RETURNING id`,
      ),
  },
  schedule_block: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO schedule_block (tenant_id, professional_id, location_id, starts_at, ends_at, reason, created_by)
              VALUES (${tenantId},
                      ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))},
                      ${overrides?.['location_id'] ?? null},
                      '2026-12-20T00:00:00Z', '2026-12-31T00:00:00Z', 'Vacation', ${randomUUID()})
              RETURNING id`,
      ),
  },
  tenant_day_off: {
    insert: (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO tenant_day_off (tenant_id, day, name, location_id, created_by)
              VALUES (${tenantId}, (date '2030-01-01' + ${nextVersion()}::int), ${unique('Day off')}, ${overrides?.['location_id'] ?? null}, ${randomUUID()})
              RETURNING id`,
      ),
  },
  professional_hours_exception: {
    insert: async (tx, tenantId, overrides) => {
      const locationId =
        overrides?.['location_id'] ??
        (await returningId(
          tx,
          sql`INSERT INTO location (tenant_id, name, time_zone)
                VALUES (${tenantId}, ${unique('Location')}, 'America/Argentina/Buenos_Aires')
                RETURNING id`,
        ));
      return returningId(
        tx,
        sql`INSERT INTO professional_hours_exception
              (tenant_id, professional_id, period_id, date_from, date_to, location_id, weekday, start_minute, end_minute, created_by)
              VALUES (${tenantId},
                      ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))},
                      ${randomUUID()}, '2026-12-01', '2026-12-15', ${locationId}, 1, 540, 780, ${randomUUID()})
              RETURNING id`,
      );
    },
  },
  appointment: {
    insert: async (tx, tenantId, overrides) => insertAppointmentRow(tx, tenantId, overrides),
  },
  appointment_event: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO appointment_event (tenant_id, appointment_id, kind, to_status)
              VALUES (${tenantId}, ${overrides?.['appointment_id'] ?? (await insertAppointmentRow(tx, tenantId))}, 'created', 'scheduled')
              RETURNING id`,
      ),
  },
  slot_hold: {
    insert: async (tx, tenantId, overrides) => {
      const professionalId =
        overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId));
      const locationId = overrides?.['location_id'] ?? (await insertLocation(tx, tenantId));
      return returningId(
        tx,
        sql`INSERT INTO slot_hold
              (tenant_id, professional_id, location_id, starts_at, ends_at, expires_at, source_key, appointment_id, status)
              VALUES (${tenantId}, ${professionalId}, ${locationId},
                      '2031-01-01T10:00:00Z', '2031-01-01T10:30:00Z', now() + interval '10 minutes',
                      ${randomUUID()}, ${overrides?.['appointment_id'] ?? null},
                      ${overrides?.['appointment_id'] ? 'converted' : 'expired'})
              RETURNING id`,
      );
    },
  },
  slot_occupancy: {
    // The runtime role cannot write this table: a row appears when an appointment is inserted.
    // The foreign keys that only the triggers can set are exercised through the tables that point
    // at the same parents, as for the care relationship.
    insert: async (tx, tenantId, overrides) => {
      if (
        overrides?.['appointment_id'] !== undefined ||
        overrides?.['slot_hold_id'] !== undefined
      ) {
        return returningId(
          tx,
          sql`INSERT INTO appointment_event (tenant_id, appointment_id, kind)
                VALUES (${tenantId}, ${overrides['appointment_id'] ?? overrides['slot_hold_id']}, 'created')
                RETURNING id`,
        );
      }
      const appointmentId = await insertAppointmentRow(tx, tenantId, overrides);
      return returningId(
        tx,
        sql`SELECT id FROM slot_occupancy WHERE appointment_id = ${appointmentId}`,
      );
    },
  },
  worklist_item: {
    insert: (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO worklist_item (tenant_id, kind, subject_type, subject_id, location_id)
              VALUES (${tenantId}, 'reminder_not_sent', 'appointment', ${randomUUID()}, ${overrides?.['location_id'] ?? null})
              RETURNING id`,
      ),
  },
};

/**
 * Joins fixture records into one. A table that two of them both fix is an error: the second would
 * silently win, and the isolation suite would test the wrong row.
 */
export function mergeFixtures(
  sources: readonly Readonly<Record<string, TenantTableFixture>>[],
): Record<string, TenantTableFixture> {
  const merged: Record<string, TenantTableFixture> = {};
  for (const source of sources) {
    for (const [table, fixture] of Object.entries(source)) {
      if (table in merged) throw new Error(`The table "${table}" has two fixtures.`);
      merged[table] = fixture;
    }
  }
  return merged;
}

/**
 * Every file of `test/support/fixtures/` exports `fixtures`: the fixtures of the tables it owns.
 * A track that adds tenant tables adds a file there; this registry never changes.
 */
const files = import.meta.glob<{ fixtures: Record<string, TenantTableFixture> }>(
  './fixtures/*.ts',
  {
    eager: true,
  },
);

export const FIXTURE_FILES: readonly string[] = Object.keys(files).sort();

export const TENANT_FIXTURES: Record<string, TenantTableFixture> = mergeFixtures([
  CORE_FIXTURES,
  ...FIXTURE_FILES.map((file) => files[file]?.fixtures ?? {}),
]);
