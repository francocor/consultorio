import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { careRelationship } from '../../../db/schema/care.js';
import {
  consentRequest,
  consentTemplate,
  consentTemplateVersion,
} from '../../../db/schema/consent.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import {
  afterStamp,
  pagedByStamp,
  pagedRows,
  stampText,
  type ExportContributor,
} from '../../tenancy/index.js';

import { openSignedRecord } from './signed-record.js';

/** Where a signed consent is in the order of the export: its patient, then the newest signature first, then its id. */
interface SignedCursor {
  patientId: string;
  at: string;
  id: string;
}

/**
 * The consent parts of the cancellation export and of the patient record export (informed-consent,
 * "Read-only tenant, export and language"; tasks 5.15 and 5.33).
 *
 * - Administrative, for the owner: the templates with all their versions (the organization's own
 *   texts), and the requests as dates and states. Never what a patient signed: no signature, no
 *   representative, no evidence. The requests are a row per consent asked for, so they are read a page
 *   at a time; the templates are the few the organization wrote and stay a list.
 * - Clinical, per professional: the signed consents of the patients that professional treats, with
 *   the signed text, the signer, the signature, the evidence, the fingerprints and the revocation.
 *   The context carries a transaction that acts as that professional, so the clinical policy of
 *   the database decides what is readable, exactly as for the clinical notes. Like them, it fails
 *   instead of delivering an empty record that would look complete when it lacks the key service
 *   or the professional. They are read a page at a time and opened (decrypted) as the exporter
 *   writes them.
 */
export const exportConsentTemplates: ExportContributor = async ({ tx, pageSize }) => {
  const templates = await tx
    .select()
    .from(consentTemplate)
    .orderBy(asc(consentTemplate.createdAt), asc(consentTemplate.id));
  const versions = await tx
    .select()
    .from(consentTemplateVersion)
    .orderBy(asc(consentTemplateVersion.templateId), asc(consentTemplateVersion.versionNumber));
  const requests = pagedByStamp({
    pageSize,
    fetch: (after, limit) =>
      tx
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
          cursorAt: stampText(consentRequest.createdAt),
          cursorId: consentRequest.id,
        })
        .from(consentRequest)
        .innerJoin(
          consentTemplateVersion,
          sql`${consentTemplateVersion.tenantId} = ${consentRequest.tenantId}
          and ${consentTemplateVersion.id} = ${consentRequest.templateVersionId}`,
        )
        .where(afterStamp(consentRequest.createdAt, consentRequest.id, after))
        .orderBy(asc(consentRequest.createdAt), asc(consentRequest.id))
        .limit(limit),
  });

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
  return ({ tx, professionalId, pageSize }) => {
    if (!keys) return Promise.reject(new Error('The consent export needs the key service'));
    if (!professionalId) {
      return Promise.reject(new Error('The consent export is made for one professional'));
    }
    // Narrowed here, for the generator below (a closure does not keep the narrowing of a parameter).
    const key: TenantKeys = keys;

    const treated = tx
      .select({ patientId: careRelationship.patientId })
      .from(careRelationship)
      .where(
        and(eq(careRelationship.professionalId, professionalId), eq(careRelationship.active, true)),
      );

    async function* consents() {
      for await (const found of pagedRows<
        { id: string; patientId: string; signedAtText: string },
        SignedCursor
      >({
        pageSize,
        fetch: (after, limit) =>
          tx
            .select({
              id: consentRequest.id,
              patientId: consentRequest.patientId,
              signedAtText: stampText(consentRequest.signedAt),
            })
            .from(consentRequest)
            .where(
              and(
                inArray(consentRequest.status, ['signed', 'revoked']),
                inArray(consentRequest.patientId, treated),
                // After the last one, in the order: patient, then the newest signature, then the id.
                after === null
                  ? undefined
                  : sql`(${consentRequest.patientId} > ${after.patientId}::uuid
                      or (${consentRequest.patientId} = ${after.patientId}::uuid
                          and (${consentRequest.signedAt} < ${after.at}::timestamptz
                               or (${consentRequest.signedAt} = ${after.at}::timestamptz
                                   and ${consentRequest.id} > ${after.id}::uuid))))`,
              ),
            )
            .orderBy(
              asc(consentRequest.patientId),
              desc(consentRequest.signedAt),
              asc(consentRequest.id),
            )
            .limit(limit),
        cursorOf: (row) => ({ patientId: row.patientId, at: row.signedAtText, id: row.id }),
      })) {
        const record = await openSignedRecord(key, tx, found.id);
        yield {
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
        };
      }
    }

    return Promise.resolve({ consents: consents() });
  };
}
