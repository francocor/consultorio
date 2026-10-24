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
  /**
   * Holds the next calls to `issue` until `release()` (a provider that is slow). By default a held
   * call gives up when its `signal` fires, like an adapter that honours it; with `ignoreSignal` it
   * keeps going and is processed after `release()`, like a transport that cannot be cancelled.
   */
  hold(options?: { ignoreSignal?: boolean }): FakeHold;
}

export interface FakeHold {
  release(): void;
  /** Resolves once a call to `issue` is waiting. */
  entered: Promise<void>;
}

const abortError = () => new DOMException('The call was aborted.', 'AbortError');

/** Waits for the gate, or rejects when the signal fires first. */
function waitFor(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void gate.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
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
  let held: { gate: Promise<void>; ignoreSignal: boolean; enter: () => void } | null = null;

  const down = (): { status: 'retryable'; message: string } => ({
    status: 'retryable',
    message: SERVICE_DOWN_MESSAGE,
  });

  const issuedResult = (prescription: FakePrescription): Issued => ({
    status: 'issued',
    externalId: prescription.externalId,
    documentUrl: documentUrlFor(prescription.externalId),
  });

  const inner: Omit<FakePrescriptionProvider, 'hold'> = {
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
      held = null;
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

  return {
    ...inner,
    hold(options = {}) {
      let release!: () => void;
      let enter!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      held = { gate, ignoreSignal: options.ignoreSignal === true, enter };
      return {
        release() {
          held = null;
          release();
        },
        entered,
      };
    },
    async issue(request, idempotencyKey, signal) {
      let honour = true;
      if (held) {
        const { gate, ignoreSignal, enter } = held;
        enter();
        honour = !ignoreSignal;
        await (ignoreSignal || !signal ? gate : waitFor(gate, signal));
      }
      if (honour && signal?.aborted) throw abortError();
      return inner.issue(request, idempotencyKey);
    },
  };
}
