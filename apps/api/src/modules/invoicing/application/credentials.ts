import { randomUUID } from 'node:crypto';

import type {
  CredentialSummaryDto,
  FieldError,
  PutCredentialRequest,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { fiscalCredential, fiscalProfile } from '../../../db/schema/index.js';
import { audit } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { parseCredential } from '../domain/credential.js';

import { credentialSummary, type FiscalActor } from './fiscal-config.js';

export interface CredentialDeps {
  keys: TenantKeys;
  clock: () => Date;
}

const TABLE = 'fiscal_credential';

/** Which part of the upload each refusal is about. */
const FIELD_OF_KEY: Record<string, 'certificate' | 'privateKey'> = {
  'invoicing.credential.certificate_unreadable': 'certificate',
  'invoicing.credential.cuit_mismatch': 'certificate',
  'invoicing.credential.expired': 'certificate',
  'invoicing.credential.not_yet_valid': 'certificate',
  'invoicing.credential.key_unreadable': 'privateKey',
  'invoicing.credential.key_mismatch': 'privateKey',
};

/**
 * Stores the certificate and key of the organization (e-invoicing-afip, "Fiscal credentials
 * lifecycle"). They are checked against the CUIT of the fiscal profile, encrypted with the tenant
 * data key bound to the row, and never returned: the answer is the state and the dates. A new
 * upload replaces the active credential, which stays as inactive history.
 *
 * The audit entry carries the fingerprint, the expiry and the state; the certificate, the key and
 * the text of any refusal stay out of it, out of the logs and out of the error.
 */
export async function putCredential(
  tx: Tx,
  deps: CredentialDeps,
  input: { actor: FiscalActor; tenantId: string; request: PutCredentialRequest },
): Promise<CredentialSummaryDto> {
  const [profile] = await tx.select().from(fiscalProfile);
  if (!profile) throw new AppError('fiscal_profile_required');

  const now = deps.clock();
  const parsed = parseCredential({
    certificate: input.request.certificate,
    privateKey: input.request.privateKey,
    expectedCuit: profile.cuit,
    now,
  });
  if (!parsed.ok) {
    const path = FIELD_OF_KEY[parsed.error.i18nKey] ?? 'certificate';
    const errors: FieldError[] = [{ path, i18nKey: parsed.error.i18nKey }];
    throw new AppError('validation_failed', errors);
  }
  const credential = parsed.value;

  const id = randomUUID();
  const certificateEnc = await deps.keys.encryptField(
    tx,
    { table: TABLE, column: 'certificate_enc', rowId: id },
    credential.certificatePem,
  );
  const privateKeyEnc = await deps.keys.encryptField(
    tx,
    { table: TABLE, column: 'private_key_enc', rowId: id },
    credential.privateKeyPem,
  );

  // The unique index allows one active credential: retire the old one first.
  await tx
    .update(fiscalCredential)
    .set({ active: false, replacedAt: now })
    .where(eq(fiscalCredential.active, true));
  const [row] = await tx
    .insert(fiscalCredential)
    .values({
      id,
      tenantId: input.tenantId,
      certificateEnc,
      privateKeyEnc,
      notBefore: credential.notBefore,
      notAfter: credential.notAfter,
      subjectCuit: credential.subjectCuit,
      fingerprint: credential.fingerprint,
      uploadedBy: input.actor.userId,
    })
    .returning();
  if (!row) throw new AppError('internal_error');

  const summary = credentialSummary(row, profile.cuit, now);
  await audit(tx, {
    action: 'invoicing.credential.changed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'fiscal_credential',
    resourceId: row.id,
    metadata: {
      fingerprint: summary.fingerprint,
      notAfter: summary.notAfter,
      state: summary.state,
    },
  });
  return summary;
}
