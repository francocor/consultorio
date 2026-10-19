import type {
  ErxSimulatorMode,
  PrescriptionCancelResult,
  PrescriptionProvider,
  PrescriptionRequest,
  PrescriptionResult,
  PrescriptionStatusResult,
  ProviderPrescriptionState,
} from '@consultorio/contracts';

import {
  KEY_REUSED_MESSAGE,
  NOT_CANCELLABLE_MESSAGE,
  SERVICE_DOWN_MESSAGE,
  TIMEOUT_MESSAGE,
  UNKNOWN_PRESCRIPTION_MESSAGE,
  documentUrlFor,
  externalIdFor,
  rejectionFor,
  requestFingerprint,
} from './prescription-rules.js';

/**
 * The in-memory prescription provider for demo organizations and unit tests (design section 6:
 * "Fake PDF"). It issues deterministic external ids, answers the same prescription to the same
 * idempotency key, refuses what the provider refuses, and can be put in the simulator modes
 * (`down`, `timeout_after_issue`) so the issue and reconcile jobs can be exercised without a
 * database. The local simulator (Track A3, `adapters/erx-local`) keeps the same state in
 * Postgres; both pass the shared contract suite (`adapters/prescription-provider.contract.ts`).
 *
 * It carries `simulated: true`: the prescriptions module reads it to say "simulated" on every
 * screen. The document address it hands out is `fake-erx://...`, which resolves to nothing.
 */

export interface FakePrescription {
  externalId: string;
  idempotencyKey: string;
  state: ProviderPrescriptionState;
  cancelReason?: string;
}

export interface FakePrescriptionProvider extends PrescriptionProvider {
  readonly simulated: true;
  mode(): ErxSimulatorMode;
  setMode(mode: ErxSimulatorMode): void;
  /** What a pharmacy or the calendar does to an issued prescription. A cancelled one stays so. */
  advance(externalId: string, to: 'dispensed' | 'expired'): void;
  /** Everything issued, oldest first. */
  prescriptions(): readonly FakePrescription[];
  /** Forgets every prescription and goes back to the `ok` mode. */
  reset(): void;
}

type Issued = Extract<PrescriptionResult, { status: 'issued' }>;
interface Stored {
  fingerprint: string;
  result: Issued | Extract<PrescriptionResult, { status: 'rejected' }>;
}

export function createFakePrescriptionProvider(): FakePrescriptionProvider {
  let mode: ErxSimulatorMode = 'ok';
  let prescriptions: FakePrescription[] = [];
  let requests = new Map<string, Stored>();
  let cancellations = new Map<string, PrescriptionCancelResult>();

  const down = (): { status: 'retryable'; message: string } => ({
    status: 'retryable',
    message: SERVICE_DOWN_MESSAGE,
  });

  const issuedResult = (prescription: FakePrescription): Issued => ({
    status: 'issued',
    externalId: prescription.externalId,
    documentUrl: documentUrlFor(prescription.externalId),
  });

  return {
    simulated: true,
    mode: () => mode,
    setMode(next) {
      mode = next;
    },
    advance(externalId, to) {
      const found = prescriptions.find((prescription) => prescription.externalId === externalId);
      if (found?.state === 'issued') found.state = to;
    },
    prescriptions: () => prescriptions.map((prescription) => ({ ...prescription })),
    reset() {
      mode = 'ok';
      prescriptions = [];
      requests = new Map();
      cancellations = new Map();
    },

    issue(request: PrescriptionRequest, idempotencyKey: string): Promise<PrescriptionResult> {
      if (mode === 'down') {
        return Promise.resolve({ ...down(), outcomeUnknown: false });
      }
      const fingerprint = requestFingerprint(request);
      const known = requests.get(idempotencyKey);
      if (known) {
        return Promise.resolve(
          known.fingerprint === fingerprint
            ? known.result
            : { status: 'rejected', message: KEY_REUSED_MESSAGE },
        );
      }

      const rejection = rejectionFor(request);
      if (rejection !== null) {
        const result: Stored['result'] = { status: 'rejected', message: rejection };
        requests.set(idempotencyKey, { fingerprint, result });
        return Promise.resolve(result);
      }

      const prescription: FakePrescription = {
        externalId: externalIdFor(idempotencyKey),
        idempotencyKey,
        state: 'issued',
      };
      prescriptions.push(prescription);
      const result = issuedResult(prescription);
      requests.set(idempotencyKey, { fingerprint, result });

      if (mode === 'timeout_after_issue') {
        mode = 'ok';
        return Promise.resolve({
          status: 'retryable',
          message: TIMEOUT_MESSAGE,
          outcomeUnknown: true,
        });
      }
      return Promise.resolve(result);
    },

    cancel(externalId, reason, idempotencyKey): Promise<PrescriptionCancelResult> {
      if (mode === 'down') {
        return Promise.resolve({ ...down(), outcomeUnknown: false });
      }
      const answered = cancellations.get(idempotencyKey);
      if (answered) return Promise.resolve(answered);

      const found = prescriptions.find((prescription) => prescription.externalId === externalId);
      let result: PrescriptionCancelResult;
      if (!found) {
        result = { status: 'rejected', message: UNKNOWN_PRESCRIPTION_MESSAGE };
      } else if (found.state !== 'issued') {
        result = { status: 'rejected', message: NOT_CANCELLABLE_MESSAGE };
      } else {
        found.state = 'cancelled';
        found.cancelReason = reason;
        result = { status: 'cancelled', externalId };
      }
      cancellations.set(idempotencyKey, result);
      return Promise.resolve(result);
    },

    findByKey(idempotencyKey): Promise<PrescriptionResult | null> {
      if (mode === 'down') {
        return Promise.resolve({ ...down(), outcomeUnknown: false });
      }
      const found = prescriptions.find(
        (prescription) => prescription.idempotencyKey === idempotencyKey,
      );
      return Promise.resolve(found ? issuedResult(found) : null);
    },

    status(externalId): Promise<PrescriptionStatusResult> {
      if (mode === 'down') return Promise.resolve(down());
      const found = prescriptions.find((prescription) => prescription.externalId === externalId);
      if (!found) return Promise.resolve({ status: 'unknown' });
      return Promise.resolve({
        status: 'found',
        externalId,
        state: found.state,
        ...(found.cancelReason === undefined ? {} : { cancelReason: found.cancelReason }),
      });
    },
  };
}
