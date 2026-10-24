import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { careRelationship } from '../../../db/schema/care.js';
import {
  consentRequest,
  consentTemplate,
  consentTemplateVersion,
} from '../../../db/schema/consent.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { ExportContributor } from '../../tenancy/index.js';

import { openSignedRecord } from './signed-record.js';

/**
 * The consent parts of the cancellation export and of the patient record export (informed-consent,
 * "Read-only tenant, export and language"; tasks 5.15 and 5.33).
 *
 * - Administrative, for the owner: the templates with all their versions (the organization's own
 *   texts), and the requests as dates and states. Never what a patient signed: no signature, no
 *   representative, no evidence.
 * - Clinical, per professional: the signed consents of the patients that professional treats, with
 *   the signed text, the signer, the signature, the evidence, the fingerprints and the revocation.
 *   The context carries a transaction that acts as that professional, so the clinical policy of
 *   the database decides what is readable, exactly as for the clinical notes. Like them, it fails
 *   instead of delivering an empty record that would look complete when it lacks the key service
 *   or the professional.
 */
export const exportConsentTemplates: ExportContributor = async ({ tx }) => {
  const templates = await tx
    .select()
    .from(consentTemplate)
    .orderBy(asc(consentTemplate.createdAt), asc(consentTemplate.id));
  const versions = await tx
    .select()
    .from(consentTemplateVersion)
    .orderBy(asc(consentTemplateVersion.templateId), asc(consentTemplateVersion.versionNumber));
  const requests = await tx
    .select({
      id: consentRequest.id,
      patientId: consentRequest.patientId,
      templateId: consentTemplateVersion.templateId,
      versionNumber: consentTemplateVersion.versionNumber,
      status: consentRequest.status,
      method: consentRequest.method,
      createdAt: consentRequest.createdAt,
      expiresAt: consentRequest.expiresAt,
      signedAt: consentRequest.signedAt,
      revokedAt: consentRequest.revokedAt,
      closedAt: consentRequest.closedAt,
    })
    .from(consentRequest)
    .innerJoin(
      consentTemplateVersion,
      sql`${consentTemplateVersion.tenantId} = ${consentRequest.tenantId}
          and ${consentTemplateVersion.id} = ${consentRequest.templateVersionId}`,
    )
    .orderBy(asc(consentRequest.createdAt), asc(consentRequest.id));

  return {
    templates: templates.map((template) => ({
      id: template.id,
      title: template.title,
      status: template.status,
      specialty: template.specialty,
      createdAt: template.createdAt,
      retiredAt: template.retiredAt,
      versions: versions
        .filter((version) => version.templateId === template.id)
        .map((version) => ({
          number: version.versionNumber,
          title: version.title,
          body: version.body,
          contentHash: version.contentHash,
          publishedAt: version.publishedAt,
        })),
    })),
    requests,
  };
};

export function exportSignedConsents(keys?: TenantKeys): ExportContributor {
  return async ({ tx, professionalId }) => {
    if (!keys) throw new Error('The consent export needs the key service');
    if (!professionalId) throw new Error('The consent export is made for one professional');

    const treated = tx
      .select({ patientId: careRelationship.patientId })
      .from(careRelationship)
      .where(
        and(eq(careRelationship.professionalId, professionalId), eq(careRelationship.active, true)),
      );
    const signed = await tx
      .select({ id: consentRequest.id })
      .from(consentRequest)
      .where(
        and(
          inArray(consentRequest.status, ['signed', 'revoked']),
          inArray(consentRequest.patientId, treated),
        ),
      )
      .orderBy(
        asc(consentRequest.patientId),
        desc(consentRequest.signedAt),
        asc(consentRequest.id),
      );

    const consents = [];
    for (const { id } of signed) {
      const record = await openSignedRecord(keys, tx, id);
      consents.push({
        requestId: record.request.id,
        patientId: record.request.patientId,
        templateId: record.version.templateId,
        version: {
          number: record.version.versionNumber,
          title: record.version.title,
          body: record.version.body,
          contentHash: record.version.contentHash,
        },
        status: record.request.status,
        method: record.signature.method,
        signerKind: record.signature.signerKind,
        representative: record.payload.representative,
        mark:
          record.payload.mark.kind === 'typed'
            ? { kind: 'typed', name: record.payload.mark.value }
            : { kind: 'drawn', imageDataUrl: record.payload.mark.value },
        signedAt: record.signature.signedAt,
        contentFingerprint: record.signature.contentFingerprint,
        fingerprintValid: record.fingerprintValid,
        evidence: record.payload.evidence,
        revocation: record.revocation
          ? {
              revokedAt: record.revocation.row.revokedAt,
              channel: record.revocation.row.channel,
              reason: record.revocation.reason,
            }
          : null,
      });
    }
    return { consents };
  };
}
