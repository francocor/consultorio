import type { SignedConsentDto } from '@consultorio/contracts';

import type {
  ConsentRequestRow,
  ConsentRevocationRow,
  ConsentSignatureRow,
  ConsentTemplateVersionRow,
} from '../../../db/schema/consent.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import {
  templateFingerprint,
  verifySignatureFingerprint,
  type SignedFacts,
} from '../domain/fingerprint.js';

import {
  findRevocation,
  findSignature,
  openRevocationReason,
  openSignature,
  requireRequest,
  toRequestDto,
  type SignaturePayload,
} from './records.js';
import { ConsentRefused } from './refusal.js';

/** A signed consent with everything it holds, decrypted. It lives in memory for one request. */
export interface SignedRecord {
  request: ConsentRequestRow;
  version: ConsentTemplateVersionRow;
  signature: ConsentSignatureRow;
  payload: SignaturePayload;
  revocation: { row: ConsentRevocationRow; reason: string | null } | null;
  /** The stored fingerprint still matches the facts, and the version still matches its own. */
  fingerprintValid: boolean;
}

/** The facts the fingerprint of a stored signature was made from. */
export function factsOf(
  request: ConsentRequestRow,
  version: ConsentTemplateVersionRow,
  signature: ConsentSignatureRow,
  payload: SignaturePayload,
): SignedFacts {
  return {
    requestId: request.id,
    patientId: request.patientId,
    versionId: version.id,
    versionFingerprint: version.contentHash,
    signerKind: signature.signerKind as SignedFacts['signerKind'],
    representative: payload.representative,
    accepted: signature.accepted,
    method: signature.method as SignedFacts['method'],
    signedAt: signature.signedAt.toISOString(),
    mark: {
      kind: payload.mark.kind,
      value: payload.mark.kind === 'typed' ? payload.mark.value : payload.markDigest,
    },
  };
}

/**
 * Opens a signed consent (or one that was revoked after being signed): the signature, its
 * encrypted record and the revocation. What the transaction may read is the database's decision:
 * a professional who treats the patient, or the portal of the patient. A request the transaction
 * cannot see does not exist; a signed one whose signature it cannot read is a refusal.
 */
export async function openSignedRecord(
  keys: TenantKeys,
  tx: Tx,
  requestId: string,
  options: { patientId?: string } = {},
): Promise<SignedRecord> {
  const { request, version } = await requireRequest(tx, requestId);
  if (options.patientId !== undefined && request.patientId !== options.patientId) {
    throw new AppError('not_found');
  }
  if (request.status !== 'signed' && request.status !== 'revoked') {
    throw new AppError('consent_not_signed');
  }
  const signature = await findSignature(tx, requestId);
  if (!signature) {
    throw new ConsentRefused('consent_record_not_readable', {
      resourceType: 'consent_request',
      resourceId: request.id,
      patientId: request.patientId,
    });
  }
  const payload = await openSignature(keys, tx, signature);
  const revocationRow = await findRevocation(tx, requestId);
  const revocation = revocationRow
    ? { row: revocationRow, reason: await openRevocationReason(keys, tx, revocationRow) }
    : null;
  const versionIntact =
    templateFingerprint({ title: version.title, body: version.body }) === version.contentHash;
  return {
    request,
    version,
    signature,
    payload,
    revocation,
    fingerprintValid:
      versionIntact &&
      verifySignatureFingerprint(
        factsOf(request, version, signature, payload),
        signature.contentFingerprint,
      ),
  };
}

/** Every read of a signed consent is audited: who, which consent, and through which door. */
export async function auditRead(
  tx: Tx,
  record: SignedRecord,
  input: { auditActor: AuditActor; via: 'view' | 'document' | 'portal' },
): Promise<void> {
  await audit(tx, {
    action: 'consent.read',
    outcome: 'allow',
    actor: input.auditActor,
    resourceType: 'consent_request',
    resourceId: record.request.id,
    patientId: record.request.patientId,
    metadata: {
      templateId: record.version.templateId,
      version: record.version.versionNumber,
      via: input.via,
    },
  });
}

export function toSignedConsentDto(record: SignedRecord, now: Date): SignedConsentDto {
  const { request, version, signature, payload, revocation } = record;
  return {
    request: toRequestDto(request, version, now),
    version: {
      id: version.id,
      number: version.versionNumber,
      title: version.title,
      body: version.body,
      contentHash: version.contentHash,
    },
    signerKind: signature.signerKind as SignedConsentDto['signerKind'],
    representative: payload.representative,
    mark:
      payload.mark.kind === 'typed'
        ? { kind: 'typed', name: payload.mark.value }
        : { kind: 'drawn', imageDataUrl: payload.mark.value },
    accepted: true,
    method: signature.method as SignedConsentDto['method'],
    signedAt: signature.signedAt.toISOString(),
    contentFingerprint: signature.contentFingerprint,
    fingerprintValid: record.fingerprintValid,
    evidence: payload.evidence,
    revocation: revocation
      ? {
          revokedAt: revocation.row.revokedAt.toISOString(),
          channel: revocation.row.channel as 'in_person' | 'portal',
          reason: revocation.reason,
        }
      : null,
  };
}
