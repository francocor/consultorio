import { asc, eq } from 'drizzle-orm';

import { SYSTEM_USER_ID, type WithTenant } from '../../../../platform/db/tenant-context.js';
import {
  consentRequest,
  consentRevocation,
  consentSignature,
  consentTemplate,
  consentTemplateVersion,
} from '../../../schema/consent.js';
import { membership } from '../../../schema/identity.js';
import { patient } from '../../../schema/patients.js';
import { documentShare, portalIdentity, portalLink } from '../../../schema/portal.js';
import { prescription } from '../../../schema/prescriptions.js';
import { professional } from '../../../schema/staff.js';

/**
 * The logical content of the Stage 5 part of a demonstration organization: what a person would
 * notice, without ids, timestamps or anything encrypted. Two seeds of the same day give equal
 * snapshots, and a reset gives back the one it started from.
 */
export interface DemoStage5Snapshot {
  templates: { title: string; status: string; versions: number }[];
  consents: {
    patient: string;
    template: string;
    version: number;
    method: string;
    status: string;
    signer: string | null;
    revokedBy: string | null;
  }[];
  prescriptions: {
    patient: string;
    prescriber: string;
    status: string;
    simulated: boolean;
    identified: boolean;
  }[];
  matriculas: { professional: string; registration: string; status: string }[];
  portal: { email: string; status: string; links: string[] }[];
  shares: { patient: string }[];
}

const sorted = <T>(rows: T[], key: (row: T) => string) =>
  [...rows].sort((a, b) => key(a).localeCompare(key(b)));

export async function snapshotDemoStage5(
  withTenant: WithTenant,
  tenantId: string,
): Promise<DemoStage5Snapshot> {
  const staff = await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
    tx
      .select({
        id: professional.id,
        name: membership.displayName,
        userId: membership.userId,
        matricula: professional.matricula,
        jurisdiction: professional.matriculaJurisdiction,
        status: professional.matriculaStatus,
      })
      .from(professional)
      .innerJoin(membership, eq(membership.id, professional.membershipId))
      .orderBy(asc(professional.matricula)),
  );

  // A prescription and a signature are clinical: each is read as the professional who may.
  const prescriptions = new Map<string, DemoStage5Snapshot['prescriptions'][number]>();
  const signatures = new Map<string, string>();
  for (const author of staff) {
    await withTenant(
      { tenantId, userId: author.userId, actingProfessionalId: author.id },
      async (tx) => {
        const written = await tx
          .select({
            id: prescription.id,
            status: prescription.status,
            simulated: prescription.simulated,
            externalId: prescription.externalId,
            family: patient.familyName,
            given: patient.givenNames,
          })
          .from(prescription)
          .innerJoin(patient, eq(patient.id, prescription.patientId))
          .where(eq(prescription.authorProfessionalId, author.id));
        for (const row of written) {
          prescriptions.set(row.id, {
            patient: `${row.family}, ${row.given}`,
            prescriber: author.name ?? '?',
            status: row.status,
            simulated: row.simulated,
            identified: row.externalId !== null,
          });
        }
        const signed = await tx
          .select({ requestId: consentSignature.requestId, signer: consentSignature.signerKind })
          .from(consentSignature);
        for (const row of signed) signatures.set(row.requestId, row.signer);
      },
    );
  }

  return withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const templates = await tx.select().from(consentTemplate);
    const versions = await tx.select().from(consentTemplateVersion);
    const requests = await tx
      .select({
        id: consentRequest.id,
        method: consentRequest.method,
        status: consentRequest.status,
        versionNumber: consentTemplateVersion.versionNumber,
        title: consentTemplateVersion.title,
        family: patient.familyName,
        given: patient.givenNames,
      })
      .from(consentRequest)
      .innerJoin(
        consentTemplateVersion,
        eq(consentTemplateVersion.id, consentRequest.templateVersionId),
      )
      .innerJoin(patient, eq(patient.id, consentRequest.patientId));
    const revocations = await tx
      .select({ requestId: consentRevocation.requestId, channel: consentRevocation.channel })
      .from(consentRevocation);
    const identities = await tx.select().from(portalIdentity);
    const links = await tx
      .select({
        identityId: portalLink.portalIdentityId,
        relationship: portalLink.relationship,
        status: portalLink.status,
        family: patient.familyName,
        given: patient.givenNames,
      })
      .from(portalLink)
      .innerJoin(patient, eq(patient.id, portalLink.patientId));
    const shares = await tx
      .select({ family: patient.familyName, given: patient.givenNames })
      .from(documentShare)
      .innerJoin(patient, eq(patient.id, documentShare.patientId));

    return {
      templates: sorted(
        templates.map((template) => ({
          title: template.title,
          status: template.status,
          versions: versions.filter((version) => version.templateId === template.id).length,
        })),
        (row) => `${row.title}|${row.status}|${String(row.versions)}`,
      ),
      consents: sorted(
        requests.map((request) => ({
          patient: `${request.family}, ${request.given}`,
          template: request.title,
          version: request.versionNumber,
          method: request.method,
          status: request.status,
          signer: signatures.get(request.id) ?? null,
          revokedBy: revocations.find((entry) => entry.requestId === request.id)?.channel ?? null,
        })),
        (row) => `${row.patient}|${row.template}|${String(row.version)}|${row.status}`,
      ),
      prescriptions: sorted(
        [...prescriptions.values()],
        (row) => `${row.patient}|${row.prescriber}|${row.status}`,
      ),
      matriculas: staff.map((entry) => ({
        professional: entry.name ?? '?',
        registration: `${entry.jurisdiction ?? ''} ${entry.matricula ?? ''}`,
        status: entry.status,
      })),
      portal: sorted(
        identities.map((identity) => ({
          email: identity.email,
          status: identity.status,
          links: links
            .filter((link) => link.identityId === identity.id)
            .map((link) => `${link.relationship}:${link.status}:${link.family}, ${link.given}`)
            .sort(),
        })),
        (row) => row.email,
      ),
      shares: sorted(
        shares.map((share) => ({ patient: `${share.family}, ${share.given}` })),
        (row) => row.patient,
      ),
    };
  });
}
