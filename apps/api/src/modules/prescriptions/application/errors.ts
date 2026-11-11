import type { ErrorCode } from '@consultorio/contracts';

import { AccessRefused } from '../../access/index.js';

/** The prescription a refusal is about, so the deny entry of the audit log can name it. */
export interface RefusedPrescription {
  prescriptionId?: string;
  patientId?: string;
}

/** A refusal (403) that knows which prescription and patient it is about. */
export class PrescriptionDenied extends AccessRefused {
  constructor(
    reason: string,
    readonly entry: RefusedPrescription = {},
  ) {
    super(reason);
    this.name = 'PrescriptionDenied';
  }
}

/**
 * The prescription is not in the state the request needs (an issued prescription cannot be edited,
 * one that is already cancelled cannot be cancelled again). The route answers with the code and
 * writes a deny entry to the audit log on its own connection, because an attempt to change a
 * prescription that must not change has to leave a trace (e-prescription, "Edit attempt").
 */
export class PrescriptionConflict extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly reason: string,
    readonly entry: RefusedPrescription = {},
  ) {
    super(reason);
    this.name = 'PrescriptionConflict';
  }
}
