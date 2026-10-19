import type { PrescriptionDto } from '@consultorio/contracts';

/**
 * What the screen calls a prescription. `pending` and `attention` are both a prescription the
 * provider has not confirmed, which is NEVER shown as valid: the first waits and is tried again by
 * itself, the second needs a person. `refused` is a prescription the provider answered and rejected.
 */
export type DisplayState =
  'issued' | 'pending' | 'attention' | 'refused' | 'cancelled' | 'dispensed' | 'expired';

export function displayState(prescription: PrescriptionDto): DisplayState {
  switch (prescription.status) {
    case 'issued':
    case 'cancelled':
    case 'dispensed':
    case 'expired':
      return prescription.status;
    case 'draft':
      return 'refused';
    case 'pending_submission':
      return prescription.failure?.kind === 'needs_attention' ? 'attention' : 'pending';
  }
}

/** What the person looking at a prescription may do with it. The server decides again. */
export interface PrescriptionActions {
  cancel: boolean;
  /** Try the provider again now. */
  retry: boolean;
  /** Register the identifier of a prescription issued on the site of the provider. */
  register: boolean;
  /** Correct a refused prescription and send it again. */
  correct: boolean;
  download: boolean;
}

/**
 * Only the prescriber changes a prescription; a colleague who treats the patient reads it and
 * downloads its document. While the provider may have issued it already (the answer was lost) nobody
 * cancels it or registers it by hand: the provider is asked first.
 */
export function actionsOf(
  prescription: PrescriptionDto,
  professionalId: string | null,
): PrescriptionActions {
  const mine = professionalId !== null && prescription.prescriber.professionalId === professionalId;
  const waiting = prescription.status === 'pending_submission';
  const refused = prescription.status === 'draft';
  const unknownOutcome = prescription.failure?.awaitingReconciliation === true;
  return {
    cancel: mine && (prescription.status === 'issued' || ((waiting || refused) && !unknownOutcome)),
    retry: mine && waiting,
    register: mine && (waiting || refused) && !unknownOutcome,
    correct: mine && refused,
    download: prescription.documentAvailable,
  };
}
