import { randomUUID } from 'node:crypto';

import { effectivePermissions, type DownloadLinkResponse } from '@consultorio/contracts';
import { and, eq, isNull } from 'drizzle-orm';

import { prescription } from '../../../db/schema/prescriptions.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import { can } from '../../../platform/authz/can.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import {
  FileRefused,
  type FileDelivery,
  type FileResource,
} from '../../../platform/files/file-resources.js';
import { AppError } from '../../../platform/http/problem.js';
import { tenantKey } from '../../../platform/storage/object-storage.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';

import { loadOrganization, type PrescriptionDeps } from './common.js';
import { DOCUMENT_STATUSES, findPrescription, hiddenOrMissing, openContent } from './read-model.js';
import { renderPrescription } from './render-prescription.js';

/** The name of the file a person downloads: made of the date and the id, never of anything typed. */
export function documentFileName(row: { prescriptionDate: string; id: string }): string {
  return `receta-${row.prescriptionDate}-${row.id.slice(-8)}.pdf`;
}

function deliveryOf(
  row: { prescriptionDate: string; id: string },
  objectKey: string,
): FileDelivery {
  return {
    objectKey,
    contentType: 'application/pdf',
    contentDisposition: `attachment; filename="${documentFileName(row)}"`,
  };
}

/**
 * Renders the PDF of a prescription the provider confirmed, stores it as
 * `t/{tenantId}/prescriptions/{uuid}.pdf` and records where it is. Safe to run again: a prescription
 * that has its document keeps it. A prescription the provider has not confirmed has none, and
 * nothing generated locally is ever offered as a valid prescription.
 *
 * The key is recorded in the transaction of the caller, which is the prescriber's or the system's.
 * A colleague who treats the patient may ask for the document too, but only the prescriber (or the
 * system) may change the row: that caller asks for `viaOwnConnection`, and the key is recorded as the
 * system on a connection of its own. It must NOT be used by a caller whose transaction already holds
 * the row (the attempt that just issued it), or the two would wait for each other.
 */
export async function storeDocument(
  tx: Tx,
  deps: PrescriptionDeps,
  prescriptionId: string,
  options: { viaOwnConnection?: boolean } = {},
): Promise<'stored' | 'exists' | 'not_ready'> {
  const row = await findPrescription(tx, prescriptionId);
  if (!row || row.externalId === null || row.issuedAt === null) return 'not_ready';
  if (!DOCUMENT_STATUSES.includes(row.status as (typeof DOCUMENT_STATUSES)[number]))
    return 'not_ready';
  if (row.documentKey !== null) return 'exists';
  if (!deps.storage) return 'not_ready';

  const organization = await loadOrganization(tx);
  const pdf = await renderPrescription({
    content: await openContent(deps.keys, tx, row),
    externalId: row.externalId,
    issuedAt: row.issuedAt,
    organizationName: organization.displayName,
    simulated: row.simulated,
    registeredManually: row.registeredManually,
  });
  const objectKey = tenantKey(organization.id, 'prescriptions', `${randomUUID()}.pdf`);
  await deps.storage.put(organization.id, objectKey, {
    body: pdf,
    contentType: 'application/pdf',
    contentLength: pdf.length,
  });
  try {
    const write = (target: Tx) =>
      target
        .update(prescription)
        .set({ documentKey: objectKey })
        .where(and(eq(prescription.id, row.id), isNull(prescription.documentKey)))
        .returning({ id: prescription.id });
    const recorded =
      options.viaOwnConnection && deps.withTenant
        ? await deps.withTenant({ tenantId: organization.id, userId: SYSTEM_USER_ID }, write)
        : await write(tx);
    if (recorded.length === 0) {
      // Somebody recorded another document first: ours is an orphan nobody can reach.
      await deps.storage.remove(organization.id, objectKey).catch(() => undefined);
      return 'exists';
    }
  } catch (error) {
    // The record was not written: the object is an orphan nobody can reach, so it is removed.
    await deps.storage.remove(organization.id, objectKey).catch(() => undefined);
    throw error;
  }
  return 'stored';
}

/**
 * A link to the PDF of a prescription, for this session only, valid for five minutes and for one
 * use. The prescription must be one the provider confirmed. Reading a prescription is open in a
 * read-only organization, and so is its link.
 */
export async function issueDocumentLink(
  tx: Tx,
  deps: PrescriptionDeps,
  input: { prescriptionId: string; sessionId: string; tokens: ActionTokens },
): Promise<DownloadLinkResponse> {
  // The policies of the database hide what this professional may not read: it answers like one that does not exist.
  const row = await findPrescription(tx, input.prescriptionId);
  if (!row) return hiddenOrMissing(tx, input.prescriptionId);
  if (!DOCUMENT_STATUSES.includes(row.status as (typeof DOCUMENT_STATUSES)[number])) {
    throw new AppError('prescription_document_not_ready');
  }
  await storeDocument(tx, deps, row.id, { viaOwnConnection: true });
  const fresh = await findPrescription(tx, row.id);
  if (!fresh?.documentKey) throw new AppError('prescription_document_not_ready');

  const issued = await input.tokens.issue(tx, {
    kind: 'prescription_pdf',
    subjectId: row.id,
    sessionId: input.sessionId,
  });
  return { url: `/files/${issued.token}`, expiresAt: issued.expiresAt.toISOString() };
}

/**
 * The prescriptions module's part of `GET /files/:token`: the links of `prescription_pdf`. The link
 * is bound to the session, works once for five minutes, and is authorized AGAIN when used: only
 * while the person still holds the clinical permission and the policies of the database still let
 * them read the prescription (the prescriber, or a professional who treats the patient).
 */
export function createPrescriptionFileResource(tokens: ActionTokens): FileResource {
  return {
    kind: 'prescription_pdf',
    audits: ['prescription.downloaded'],
    async redeem(tx, input) {
      const redeemed = await tokens.redeem(tx, 'prescription_pdf', input.token, {
        sessionId: input.sessionId,
      });
      // Not a live link of this kind: the door asks the other resources before it refuses.
      if (!redeemed) return null;

      const mayStill =
        input.actor.professionalId !== null &&
        effectivePermissions(input.actor.roles, input.actor.grants).includes(
          'clinical.prescription.read',
        );
      const row = mayStill ? await findPrescription(tx, redeemed.subjectId) : undefined;
      if (!row) {
        throw new FileRefused('prescription_not_allowed', 'prescription', {
          resourceId: redeemed.subjectId,
        });
      }
      if (
        !DOCUMENT_STATUSES.includes(row.status as (typeof DOCUMENT_STATUSES)[number]) ||
        row.documentKey === null
      ) {
        throw new FileRefused('prescription_not_ready', 'prescription', {
          resourceId: row.id,
          patientId: row.patientId,
        });
      }
      await audit(tx, {
        action: 'prescription.downloaded',
        outcome: 'allow',
        actor: input.auditActor,
        resourceType: 'prescription',
        resourceId: row.id,
        patientId: row.patientId,
        metadata: { via: 'staff' },
      });
      return deliveryOf(row, row.documentKey);
    },
  };
}

/** What the portal needs to open the document of a prescription of its subject. */
export interface PortalDocumentInput {
  actor: PortalActor;
  patientId: string;
  prescriptionId: string;
  auditActor: AuditActor;
}

/**
 * The document of one prescription of one patient, for the portal (S5.09). The patient is the
 * subject of the portal session, decided by the portal, never by the request. Only a prescription the
 * provider confirmed has a document; a cancelled one has none to give. The download is audited with
 * the actor the portal passes. Runs as the system on a connection of its own: the clinical policies
 * of the database are for professionals, and the portal's authorization is its link to the patient.
 */
export async function openPortalDocument(
  withTenant: WithTenant,
  deps: PrescriptionDeps,
  input: PortalDocumentInput,
): Promise<FileDelivery | null> {
  const decision = can(input.actor, 'portal.prescription.read', { tenantId: input.actor.tenantId });
  if (!decision.allowed) return null;
  return withTenant({ tenantId: input.actor.tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const row = await findPrescription(tx, input.prescriptionId);
    if (
      !row ||
      row.patientId !== input.patientId ||
      !DOCUMENT_STATUSES.includes(row.status as (typeof DOCUMENT_STATUSES)[number])
    ) {
      return null;
    }
    await storeDocument(tx, deps, row.id);
    const fresh = await findPrescription(tx, row.id);
    if (!fresh?.documentKey) return null;
    await audit(tx, {
      action: 'prescription.downloaded',
      outcome: 'allow',
      actor: input.auditActor,
      resourceType: 'prescription',
      resourceId: row.id,
      patientId: row.patientId,
      metadata: { via: 'portal' },
    });
    return deliveryOf(fresh, fresh.documentKey);
  });
}
