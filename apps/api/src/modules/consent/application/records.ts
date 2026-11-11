import type { ConsentRequestDto, ConsentRequestStatus } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  consentRequest,
  consentRevocation,
  consentSignature,
  consentTemplateVersion,
  type ConsentRequestRow,
  type ConsentRevocationRow,
  type ConsentSignatureRow,
  type ConsentTemplateVersionRow,
} from '../../../db/schema/consent.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { effectiveStatus } from '../domain/visibility.js';

/** The organization of the transaction, as a value for an insert. */
export const tenantId = sql`current_setting('app.tenant_id')::uuid`;

/** Where the encrypted columns live; the ciphertext is bound to table, column and row. */
export const SIGNATURE_FIELD = { table: 'consent_signature', column: 'payload_enc' } as const;
export const REVOCATION_REASON_FIELD = {
  table: 'consent_revocation',
  column: 'reason_enc',
} as const;

export interface RequestWithVersion {
  request: ConsentRequestRow;
  version: ConsentTemplateVersionRow;
}

/**
 * A request and the version it is bound to. With `lock`, the row is locked until the end of the
 * transaction, so two people signing (or one signing and one revoking) take turns. A request the
 * transaction cannot see does not exist for it.
 */
export async function findRequest(
  tx: Tx,
  requestId: string,
  options: { lock?: boolean } = {},
): Promise<RequestWithVersion | undefined> {
  const query = tx
    .select({ request: consentRequest, version: consentTemplateVersion })
    .from(consentRequest)
    .innerJoin(
      consentTemplateVersion,
      sql`${consentTemplateVersion.tenantId} = ${consentRequest.tenantId}
          and ${consentTemplateVersion.id} = ${consentRequest.templateVersionId}`,
    )
    .where(eq(consentRequest.id, requestId));
  const [row] = await (options.lock ? query.for('update', { of: consentRequest }) : query);
  return row;
}

export async function requireRequest(
  tx: Tx,
  requestId: string,
  options: { lock?: boolean } = {},
): Promise<RequestWithVersion> {
  const found = await findRequest(tx, requestId, options);
  if (!found) throw new AppError('not_found');
  return found;
}

export function toRequestDto(
  row: ConsentRequestRow,
  version: Pick<ConsentTemplateVersionRow, 'templateId' | 'id' | 'versionNumber'>,
  now: Date,
): ConsentRequestDto {
  return {
    id: row.id,
    patientId: row.patientId,
    templateId: version.templateId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    status: effectiveStatus(row.status as ConsentRequestStatus, row.expiresAt, now),
    method: row.method as ConsentRequestDto['method'],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    signedAt: row.signedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** What is kept encrypted of a signature: the personal part of the signed record. */
export const SignaturePayload = z.strictObject({
  /** 1: signed before the name was covered by the fingerprint. 2: the name is covered (A-W3). */
  v: z.union([z.literal(1), z.literal(2)]),
  representative: z
    .strictObject({ name: z.string(), nationalId: z.string(), relation: z.string() })
    .nullable(),
  /** The full name the signer typed (absent in a record signed before it was kept). */
  signerName: z.string().optional(),
  /** The typed name, or the drawn image as a data URL. */
  mark: z.strictObject({ kind: z.enum(['typed', 'drawn']), value: z.string() }),
  /** The SHA-256 (hex) of the typed name or of the bytes of the image: what the fingerprint covers. */
  markDigest: z.string(),
  evidence: z.strictObject({
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    requestId: z.string().nullable(),
  }),
});
export type SignaturePayload = z.infer<typeof SignaturePayload>;

export async function openSignature(
  keys: TenantKeys,
  tx: Tx,
  row: ConsentSignatureRow,
): Promise<SignaturePayload> {
  const plain = await keys.decryptField(tx, { ...SIGNATURE_FIELD, rowId: row.id }, row.payloadEnc);
  return SignaturePayload.parse(JSON.parse(plain.toString('utf8')));
}

export async function openRevocationReason(
  keys: TenantKeys,
  tx: Tx,
  row: ConsentRevocationRow,
): Promise<string | null> {
  if (row.reasonEnc === null) return null;
  const plain = await keys.decryptField(
    tx,
    { ...REVOCATION_REASON_FIELD, rowId: row.id },
    row.reasonEnc,
  );
  return plain.toString('utf8');
}

/** The signature of a request. Only a transaction the clinical policy lets read it finds one. */
export async function findSignature(
  tx: Tx,
  requestId: string,
): Promise<ConsentSignatureRow | undefined> {
  const [row] = await tx
    .select()
    .from(consentSignature)
    .where(eq(consentSignature.requestId, requestId));
  return row;
}

export async function findRevocation(
  tx: Tx,
  requestId: string,
): Promise<ConsentRevocationRow | undefined> {
  const [row] = await tx
    .select()
    .from(consentRevocation)
    .where(eq(consentRevocation.requestId, requestId));
  return row;
}

/**
 * Lets the portal read the signature of the patient it serves, and no other (the SELECT policy of
 * `consent_signature`). The portal entry points call it with the subject the portal resolved from
 * the session, never with an id from a parameter.
 */
export async function allowPortalSubject(tx: Tx, patientId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.consent_portal_patient', ${patientId}, true)`);
}
