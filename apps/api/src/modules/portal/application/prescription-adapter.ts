import type { PortalPrescriptionDto } from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import type { DownloadPurpose, PortalPrescriptionPort } from './ports.js';

/** What the prescriptions module asks of every call: the actor, the subject and the audit actor. */
export interface PrescriptionModuleInput {
  actor: PortalActor;
  patientId: string;
  auditActor: AuditActor;
  /** Where the page starts: the cursor the previous page gave. Absent for the first page. */
  cursor?: string | undefined;
}

/** A page of what the module lists, and where the next one starts. */
export interface ModulePrescriptionPage {
  prescriptions: ModulePrescription[];
  nextCursor: string | null;
}

/** `PortalPrescriptionListing` of the prescriptions module: what it lists, never a medication. */
export interface ModulePrescription {
  id: string;
  issuedAt: string;
  status: 'issued' | 'cancelled' | 'dispensed' | 'expired';
  /** Whether the module can give a document for it now (kept, or made on request). */
  hasDocument: boolean;
}

/** `FileDelivery` of the platform: the object to stream and the headers its owner decided. */
export interface ModuleFileDelivery {
  objectKey: string;
  contentType: string;
  contentDisposition: string;
}

/** `PortalDocument` of the prescriptions module: the stored PDF, or the one rendered just now. */
export type ModuleDocument =
  | { kind: 'stored'; delivery: ModuleFileDelivery }
  | { kind: 'rendered'; bytes: Buffer; fileName: string; contentType: string };

/**
 * The two entry points of `modules/prescriptions` for the portal, as closures over the
 * `PrescriptionDeps` the integrator already holds:
 *
 *   adaptPrescriptionModule({
 *     list: (tx, input) => listPrescriptionsForPatient(tx, input),
 *     openDocument: (tx, input) => openPortalDocument(tx, deps, input),
 *   })
 *
 * (`openDocument` receives the prescription id as a field of its input.) Both run on the
 * transaction of the portal request, which the portal opened for the subject of the session: they
 * never open another connection while it is held (JD-S5 R1-S5-1), and the table of prescriptions
 * is closed to the portal, so they read through the functions of the database bound to the link of
 * that transaction (JD-S5 R1-S5-2). Both check `portal.prescription.read` themselves.
 */
export interface PrescriptionModulePortal {
  list(tx: Tx, input: PrescriptionModuleInput): Promise<ModulePrescriptionPage>;
  openDocument(
    tx: Tx,
    input: PrescriptionModuleInput & { prescriptionId: string; purpose: DownloadPurpose },
  ): Promise<ModuleDocument | null>;
}

const FALLBACK_FILE_NAME = 'receta.pdf';

/** The file name the module chose, read back from its `content-disposition`. */
export function fileNameOf(contentDisposition: string): string {
  const match = /filename="([^"\r\n]+)"/.exec(contentDisposition);
  return match?.[1] ?? FALLBACK_FILE_NAME;
}

/**
 * Wires the prescriptions module into the portal. The mapping:
 *
 * - list: the module's list (confirmed prescriptions only, no medication). The portal adds
 *   `prescriberName: null` (the module does not say who prescribed). Whether there is a document is
 *   the module's answer (`hasDocument`), never inferred from the status here.
 * - document: a stored PDF is a storage object, which fits the file door as it is (its file name is
 *   read back from the `content-disposition` the module set); one rendered just now travels as its
 *   bytes.
 *
 * The module audits `prescription.read` on the list and `prescription.downloaded` (via the portal)
 * whenever it opens the document; the door adds `portal.download` when the link is used.
 */
export function adaptPrescriptionModule(module: PrescriptionModulePortal): PortalPrescriptionPort {
  return {
    async list(tx, call) {
      const listed = await module.list(tx, {
        actor: call.actor,
        patientId: call.subject.patientId,
        auditActor: call.auditActor,
        cursor: call.cursor,
      });
      return {
        prescriptions: listed.prescriptions.map((entry): PortalPrescriptionDto => ({
          id: entry.id,
          issuedAt: entry.issuedAt,
          status: entry.status,
          prescriberName: null,
          hasDocument: entry.hasDocument,
        })),
        nextCursor: listed.nextCursor,
      };
    },

    async document(tx, call) {
      const opened = await module.openDocument(tx, {
        actor: call.actor,
        patientId: call.subject.patientId,
        auditActor: call.auditActor,
        prescriptionId: call.prescriptionId,
        purpose: call.purpose,
      });
      if (!opened) return null;
      if (opened.kind === 'rendered') {
        return { bytes: opened.bytes, fileName: opened.fileName, contentType: opened.contentType };
      }
      return {
        objectKey: opened.delivery.objectKey,
        contentType: opened.delivery.contentType,
        fileName: fileNameOf(opened.delivery.contentDisposition),
      };
    },
  };
}
