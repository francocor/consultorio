import { randomUUID } from 'node:crypto';

import { effectivePermissions, type DownloadLinkResponse } from '@consultorio/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { prescription } from '../../../db/schema/prescriptions.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import { can } from '../../../platform/authz/can.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import {
  FileRefused,
  type FileDelivery,
  type FileResource,
} from '../../../platform/files/file-resources.js';
import { AppError } from '../../../platform/http/problem.js';
import { tenantKey } from '../../../platform/storage/object-storage.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { parseContent } from '../domain/prescription.js';

import { CONTENT_FIELD, loadOrganization, sqlState, type PrescriptionDeps } from './common.js';
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
 * The key is recorded in the transaction of the caller, who is anyone that can read the row: the
 * prescriber, the system, or a colleague who treats the patient (the guard of the table lets whoever
 * reads a prescription record its document, once, and nothing else). It never opens a connection of
 * its own (JD-S5 R1-S5-1): a request that holds one and waits for another can exhaust the pool.
 */
export async function storeDocument(
  tx: Tx,
  deps: PrescriptionDeps,
  prescriptionId: string,
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
    const recorded = await tx
      .update(prescription)
      .set({ documentKey: objectKey })
      .where(and(eq(prescription.id, row.id), isNull(prescription.documentKey)))
      .returning({ id: prescription.id });
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
  await storeDocument(tx, deps, row.id);
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
  /**
   * `link`: the portal only asks whether the document exists and is the patient's, to issue a link,
   * and nothing leaves, so nothing is audited. `download`: the document goes out and the download is
   * audited, once. Absent means `download`, so a caller that forgets to say audits too much, never too little.
   */
  purpose?: 'link' | 'download';
}

/**
 * What the portal gets for a prescription: the stored PDF (the usual case, made when the provider
 * confirmed the prescription) or, when there is none yet, the PDF rendered at this moment. The
 * portal never writes a prescription, so it does not store the one it renders.
 */
export type PortalDocument =
  | { kind: 'stored'; delivery: FileDelivery }
  | { kind: 'rendered'; bytes: Buffer; fileName: string; contentType: string };

/** The prescription the database gives the portal for the PDF (`app.portal_prescription`). */
interface PortalDocumentRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  status: string;
  prescription_date: string;
  external_id: string;
  /** The driver gives a timestamp of a raw statement as text. */
  issued_at: string | Date;
  simulated: boolean;
  registered_manually: boolean;
  document_key: string | null;
  content_enc: Buffer;
}

/**
 * The document of one prescription of one patient, for the portal (S5.09). The patient is the
 * subject of the portal session, decided by the portal, never by the request. Only a prescription the
 * provider confirmed has a document; a cancelled one has none to give. The download is audited with
 * the actor the portal passes.
 *
 * It runs on the transaction of the portal request and opens no other (JD-S5 R1-S5-1). The portal is
 * not a professional, so the table is closed to it (JD-S5 R1-S5-2): the row comes from
 * `app.portal_prescription`, which answers only for the link bound to the transaction, and a PDF
 * that was not made yet is rendered from the encrypted content here and handed over from memory.
 */
export async function openPortalDocument(
  tx: Tx,
  deps: PrescriptionDeps,
  input: PortalDocumentInput,
): Promise<PortalDocument | null> {
  const decision = can(input.actor, 'portal.prescription.read', { tenantId: input.actor.tenantId });
  if (!decision.allowed) return null;

  const found = await tx.execute<PortalDocumentRow>(
    sql`select id, patient_id, status, prescription_date::text as prescription_date, external_id,
               issued_at, simulated, registered_manually, document_key, content_enc
          from app.portal_prescription(${input.prescriptionId}::uuid)`,
  );
  const row = found.rows[0];
  if (
    !row ||
    row.patient_id !== input.patientId ||
    !DOCUMENT_STATUSES.includes(row.status as (typeof DOCUMENT_STATUSES)[number])
  ) {
    return null;
  }

  if (input.purpose !== 'link') {
    await audit(tx, {
      action: 'prescription.downloaded',
      outcome: 'allow',
      actor: input.auditActor,
      resourceType: 'prescription',
      resourceId: row.id,
      patientId: row.patient_id,
      metadata: { via: 'portal' },
    });
  }
  const names = { prescriptionDate: row.prescription_date, id: row.id };
  if (row.document_key !== null) {
    return { kind: 'stored', delivery: deliveryOf(names, row.document_key) };
  }
  // Nothing was stored yet (the first attempt could not make it): the PDF is made now, from memory.
  // A link is issued only for a document that CAN be made (JD-S5 R2, B-S7): the link works once, and
  // it must not be spent on a download that cannot happen. The bytes of the check are not kept.
  let bytes: Buffer;
  try {
    const organization = await loadOrganization(tx);
    const plain = await deps.keys.decryptField(
      tx,
      { ...CONTENT_FIELD, rowId: row.id },
      row.content_enc,
    );
    bytes = await renderPrescription({
      content: parseContent(plain.toString('utf8')),
      externalId: row.external_id,
      issuedAt: new Date(row.issued_at),
      organizationName: organization.displayName,
      simulated: row.simulated,
      registeredManually: row.registered_manually,
    });
  } catch (error) {
    deps.log?.error(
      { prescriptionId: row.id, code: sqlState(error) ?? 'unknown' },
      'the document of a prescription could not be made for the portal',
    );
    return null;
  }
  return {
    kind: 'rendered',
    // A link only needs to know the document can be made; the download carries the bytes.
    bytes: input.purpose === 'link' ? Buffer.alloc(0) : bytes,
    fileName: documentFileName(names),
    contentType: 'application/pdf',
  };
}
