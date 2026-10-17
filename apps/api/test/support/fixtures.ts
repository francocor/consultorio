import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Tx } from '../../src/platform/db/tenant-context.js';

/**
 * One fixture per tenant table. The generated isolation suite uses it to put a row into a table
 * without knowing the table: a table with no fixture here FAILS the suite, so adding a tenant
 * table forces whoever adds it to say how to create a valid row.
 */
export interface TenantTableFixture {
  /**
   * Inserts one row owned by `tenantId` and returns its id. The caller has already set the tenant
   * context, which may differ from `tenantId` (that is how cross-tenant writes are tested).
   * `overrides` replaces foreign key columns, keyed by column name, with ids of another tenant.
   */
  insert(tx: Tx, tenantId: string, overrides?: Readonly<Record<string, string>>): Promise<string>;
}

async function returningId(tx: Tx, statement: ReturnType<typeof sql>): Promise<string> {
  const result = await tx.execute<{ id: string }>(statement);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('fixture insert returned no id');
  return id;
}

let versionCounter = 100;
/** Distinct key versions for fixtures (the version is unique per tenant). */
function nextVersion(): number {
  versionCounter += 1;
  return versionCounter;
}

let counter = 0;
/** Unique suffix so repeated fixtures never collide on a unique business key. */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

/**
 * A new account, inserted the way the application does it: acting AS that user. The account
 * policy only accepts the row of `app.user_id`, so the fixture points it at the new id for the
 * insert and puts the caller's value back afterwards.
 */
async function insertUser(tx: Tx): Promise<string> {
  const id = randomUUID();
  const previous = await tx.execute<{ value: string }>(
    sql`select current_setting('app.user_id') as value`,
  );
  await tx.execute(sql`select set_config('app.user_id', ${id}, true)`);
  await tx.execute(
    sql`INSERT INTO user_account (id, email, password_hash)
          VALUES (${id}, ${unique('fixture') + '@example.test'}, 'hash')`,
  );
  await tx.execute(sql`select set_config('app.user_id', ${previous.rows[0]?.value ?? ''}, true)`);
  return id;
}

async function insertMembership(tx: Tx, tenantId: string, userId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO membership (tenant_id, user_id, roles)
          VALUES (${tenantId}, ${userId}, ARRAY['reception']) RETURNING id`,
  );
}

async function insertProfessional(tx: Tx, tenantId: string): Promise<string> {
  const membershipId = await insertMembership(tx, tenantId, await insertUser(tx));
  return returningId(
    tx,
    sql`INSERT INTO professional (tenant_id, membership_id, specialties)
          VALUES (${tenantId}, ${membershipId}, ARRAY['general'])
          RETURNING id`,
  );
}

async function insertPatient(tx: Tx, tenantId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date)
          VALUES (${tenantId}, ${unique('Apellido')}, 'Nombre', '1990-01-01')
          RETURNING id`,
  );
}

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

export const TENANT_FIXTURES: Record<string, TenantTableFixture> = {
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
          sql`INSERT INTO encounter (tenant_id, patient_id, author_professional_id, template_kind)
                VALUES (${tenantId}, ${patientId}, ${authorId}, 'general') RETURNING id`,
        ),
      );
      CLINICAL_AUTHORS.set(id, authorId);
      return id;
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
                                    template_kind, kind, reason, content_enc)
                VALUES (${tenantId}, ${overrides?.['note_id'] ?? noteId}, ${overrides?.['patient_id'] ?? opened.patientId},
                        ${actor}, 'default', 'general', 'correction', 'Corrección', ${Buffer.from([1])})
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
  tenant_feature: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO tenant_feature (tenant_id, feature, enabled)
              VALUES (${tenantId}, ${unique('feature')}, true)
              RETURNING id`,
      ),
  },
};
