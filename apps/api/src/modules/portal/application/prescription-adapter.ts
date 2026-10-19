import type { PortalPrescriptionDto } from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';

import type { DownloadPurpose, PortalPrescriptionPort } from './ports.js';

/** What the prescriptions module asks of every call: the actor, the subject and the audit actor. */
export interface PrescriptionModuleInput {
  actor: PortalActor;
  patientId: string;
  auditActor: AuditActor;
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

/**
 * The two entry points of `modules/prescriptions` for the portal, as closures over the
 * `withTenant` and the `PrescriptionDeps` the integrator already holds:
 *
 *   adaptPrescriptionModule({
 *     list: (input) => listPrescriptionsForPatient(withTenant, input),
 *     openDocument: (input) => openPortalDocument(withTenant, deps, input),
 *   })
 *
 * (`openDocument` receives the prescription id as a field of its input.) Both run their own
 * transaction as the system and check `portal.prescription.read` themselves.
 */
export interface PrescriptionModulePortal {
  list(input: PrescriptionModuleInput): Promise<ModulePrescription[]>;
  openDocument(
    input: PrescriptionModuleInput & { prescriptionId: string; purpose: DownloadPurpose },
  ): Promise<ModuleFileDelivery | null>;
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
 * - document: the module's `FileDelivery` is a storage object, which fits the file door as it is.
 *   Its file name is read back from the `content-disposition` the module set.
 *
 * The module audits `prescription.read` on the list and `prescription.downloaded` (via the portal)
 * whenever it opens the document; the door adds `portal.download` when the link is used.
 */
export function adaptPrescriptionModule(module: PrescriptionModulePortal): PortalPrescriptionPort {
  return {
    async list(_tx, call) {
      const listed = await module.list({
        actor: call.actor,
        patientId: call.subject.patientId,
        auditActor: call.auditActor,
      });
      return listed.map((entry): PortalPrescriptionDto => ({
        id: entry.id,
        issuedAt: entry.issuedAt,
        status: entry.status,
        prescriberName: null,
        hasDocument: entry.hasDocument,
      }));
    },

    async document(_tx, call) {
      const delivery = await module.openDocument({
        actor: call.actor,
        patientId: call.subject.patientId,
        auditActor: call.auditActor,
        prescriptionId: call.prescriptionId,
        purpose: call.purpose,
      });
      return delivery
        ? {
            objectKey: delivery.objectKey,
            contentType: delivery.contentType,
            fileName: fileNameOf(delivery.contentDisposition),
          }
        : null;
    },
  };
}
