import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Tx } from '../../src/platform/db/tenant-context.js';

import { insertPatient, returningId, unique } from './fixture-helpers.js';

/**
 * Rows of the consent tables, written with plain SQL the way the isolation suite and the schema
 * tests need them (the application services have their own tests). A foreign key column can be
 * replaced through `overrides`, keyed by column name.
 */
type Overrides = Readonly<Record<string, string>>;

const HASH = 'a'.repeat(64);

export async function insertConsentTemplate(
  tx: Tx,
  tenantId: string,
  overrides?: Overrides,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO consent_template (tenant_id, title, draft_body, appointment_type_id, created_by)
          VALUES (${tenantId}, ${unique('Extraccion')}, 'Texto del consentimiento.',
                  ${overrides?.['appointment_type_id'] ?? null}, gen_random_uuid())
          RETURNING id`,
  );
}

export async function insertConsentTemplateVersion(
  tx: Tx,
  tenantId: string,
  overrides?: Overrides,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO consent_template_version
          (tenant_id, template_id, version_number, title, body, content_hash, published_by)
          VALUES (${tenantId},
                  ${overrides?.['template_id'] ?? (await insertConsentTemplate(tx, tenantId))},
                  1, ${unique('Extraccion')}, 'Texto del consentimiento.', ${HASH}, gen_random_uuid())
          RETURNING id`,
  );
}

export interface RequestValues {
  method?: 'in_person' | 'portal';
  expiresAt?: Date;
}

export async function insertConsentRequest(
  tx: Tx,
  tenantId: string,
  overrides?: Overrides,
  values: RequestValues = {},
): Promise<string> {
  const expiresAt = values.expiresAt ?? new Date(Date.now() + 7 * 86_400_000);
  return returningId(
    tx,
    sql`INSERT INTO consent_request
          (tenant_id, patient_id, template_version_id, appointment_id, encounter_id, method,
           expires_at, requested_by)
          VALUES (${tenantId},
                  ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                  ${overrides?.['template_version_id'] ?? (await insertConsentTemplateVersion(tx, tenantId))},
                  ${overrides?.['appointment_id'] ?? null},
                  ${overrides?.['encounter_id'] ?? null},
                  ${values.method ?? 'in_person'}, ${expiresAt.toISOString()}::timestamptz,
                  gen_random_uuid())
          RETURNING id`,
  );
}

export async function readRequest(tx: Tx, requestId: string) {
  const result = await tx.execute<{
    patient_id: string;
    template_version_id: string;
    method: string;
    status: string;
    signed_at: string | null;
    revoked_at: string | null;
    closed_at: string | null;
  }>(
    sql`SELECT patient_id, template_version_id, method, status, signed_at, revoked_at, closed_at
          FROM consent_request WHERE id = ${requestId}`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('no such consent request');
  const date = (value: string | null) => (value === null ? null : new Date(value));
  return {
    ...row,
    signed_at: date(row.signed_at),
    revoked_at: date(row.revoked_at),
    closed_at: date(row.closed_at),
  };
}

/** A signature of the request, in the way its method says (an in-person one by a staff user). */
export async function insertConsentSignature(
  tx: Tx,
  tenantId: string,
  overrides?: Overrides,
  values: { signedAt?: Date; accepted?: boolean } = {},
): Promise<{ id: string; requestId: string; patientId: string; versionId: string }> {
  const patientId = overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId));
  const requestOverrides: Record<string, string> = { patient_id: patientId };
  const requestId =
    overrides?.['request_id'] ?? (await insertConsentRequest(tx, tenantId, requestOverrides));
  const versionId =
    overrides?.['template_version_id'] ??
    (
      await tx.execute<{ template_version_id: string }>(
        sql`SELECT template_version_id FROM consent_request WHERE id = ${requestId}`,
      )
    ).rows[0]?.template_version_id ??
    (await insertConsentTemplateVersion(tx, tenantId));
  // No RETURNING: a signature is written by whoever records the signing but read back by a
  // professional only, so the id is made here (the SELECT policy would refuse to return the row).
  const id = randomUUID();
  await tx.execute(
    sql`INSERT INTO consent_signature
          (id, tenant_id, request_id, patient_id, template_version_id, signer_kind, accepted, method,
           payload_enc, content_fingerprint, signed_at, recorded_by)
          VALUES (${id}, ${tenantId}, ${requestId}, ${patientId}, ${versionId}, 'patient',
                  ${values.accepted ?? true}, 'in_person', ${Buffer.from('cifrado')}, ${HASH},
                  ${(values.signedAt ?? new Date()).toISOString()}::timestamptz, ${randomUUID()})`,
  );
  return { id, requestId, patientId, versionId };
}

export async function insertConsentRevocation(
  tx: Tx,
  tenantId: string,
  overrides?: Overrides,
): Promise<string> {
  const signed =
    overrides?.['request_id'] === undefined
      ? await insertConsentSignature(tx, tenantId)
      : undefined;
  const requestId = overrides?.['request_id'] ?? signed?.requestId ?? '';
  const patientId =
    overrides?.['patient_id'] ?? signed?.patientId ?? (await insertPatient(tx, tenantId));
  return returningId(
    tx,
    sql`INSERT INTO consent_revocation
          (tenant_id, request_id, patient_id, channel, actor_user_id, revoked_at)
          VALUES (${tenantId}, ${requestId}, ${patientId}, 'in_person', ${randomUUID()}, now())
          RETURNING id`,
  );
}
