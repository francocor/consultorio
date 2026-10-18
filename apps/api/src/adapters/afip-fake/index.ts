import type {
  AfipSimulatorMode,
  InvoiceIssuer,
  InvoiceRef,
  InvoiceRequest,
  IssueResult,
} from '@consultorio/contracts';

import {
  DEFAULT_SLOW_MS,
  KEY_REUSED_MESSAGE,
  SERVICE_DOWN_MESSAGE,
  SIMULATED_REJECTION_MESSAGE,
  TIMEOUT_MESSAGE,
  caeExpiresOn,
  caeFor,
  rejectionFor,
  requestFingerprint,
} from '../afip-local/voucher-rules.js';

/**
 * The in-memory invoice issuer for demo organizations and unit tests (design section 6:
 * "deterministic fake CAE"). It numbers vouchers in sequence per issuer, point of sale and type,
 * answers the same voucher to the same idempotency key, refuses what AFIP refuses, and can be put
 * in the simulator modes (`down`, `slow`, `timeout_after_authorize`, `reject_next`) so the issue
 * job can be exercised without a database. The local simulator (`afip-local`) keeps the same state
 * in Postgres; both pass the shared contract suite (`adapters/invoice-issuer.contract.ts`).
 *
 * It carries `simulated: true`: the invoicing module reads it to say "simulated" on every screen.
 */

export interface FakeVoucher {
  issuerCuit: string;
  pointOfSale: number;
  type: string;
  number: number;
  cae: string;
  caeExpiresOn: string;
  issueDate: string;
  totalCents: number;
  idempotencyKey: string;
}

export interface FakeInvoiceIssuer extends InvoiceIssuer {
  readonly simulated: true;
  mode(): AfipSimulatorMode;
  setMode(mode: AfipSimulatorMode): void;
  /** Everything issued, oldest first. */
  vouchers(): readonly FakeVoucher[];
  /** Forgets every voucher and goes back to the `ok` mode. */
  reset(): void;
}

export interface FakeInvoiceIssuerOptions {
  /** How long the `slow` mode keeps a request waiting. */
  slowMs?: number;
}

type Decided = Extract<IssueResult, { status: 'issued' | 'rejected' }>;
interface Stored {
  fingerprint: string;
  result: Decided;
}

export function createFakeInvoiceIssuer(options: FakeInvoiceIssuerOptions = {}): FakeInvoiceIssuer {
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  let mode: AfipSimulatorMode = 'ok';
  let vouchers: FakeVoucher[] = [];
  let requests = new Map<string, Stored>();

  const lastNumber = (request: InvoiceRequest) =>
    vouchers
      .filter(
        (voucher) =>
          voucher.issuerCuit === request.issuerCuit &&
          voucher.pointOfSale === request.pointOfSale &&
          voucher.type === request.type,
      )
      .reduce((highest, voucher) => Math.max(highest, voucher.number), 0);

  const issuedResult = (voucher: FakeVoucher): Decided => ({
    status: 'issued',
    number: voucher.number,
    cae: voucher.cae,
    caeExpiresOn: voucher.caeExpiresOn,
  });

  return {
    simulated: true,
    mode: () => mode,
    setMode(next) {
      mode = next;
    },
    vouchers: () => [...vouchers],
    reset() {
      mode = 'ok';
      vouchers = [];
      requests = new Map();
    },

    async issue(request, idempotencyKey): Promise<IssueResult> {
      if (mode === 'down') {
        return { status: 'retryable', message: SERVICE_DOWN_MESSAGE, outcomeUnknown: false };
      }
      const fingerprint = requestFingerprint(request);
      const known = requests.get(idempotencyKey);
      if (known) {
        return known.fingerprint === fingerprint
          ? known.result
          : { status: 'rejected', message: KEY_REUSED_MESSAGE };
      }
      if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, slowMs));

      const rejection =
        mode === 'reject_next' ? SIMULATED_REJECTION_MESSAGE : rejectionFor(request);
      if (mode === 'reject_next') mode = 'ok';
      if (rejection !== null) {
        const result: Decided = { status: 'rejected', message: rejection };
        requests.set(idempotencyKey, { fingerprint, result });
        return result;
      }

      const identity = {
        issuerCuit: request.issuerCuit ?? '',
        pointOfSale: request.pointOfSale,
        type: request.type,
        number: lastNumber(request) + 1,
      };
      const voucher: FakeVoucher = {
        ...identity,
        cae: caeFor(identity),
        caeExpiresOn: caeExpiresOn(request.issueDate),
        issueDate: request.issueDate,
        totalCents: request.totalCents,
        idempotencyKey,
      };
      vouchers.push(voucher);
      const result = issuedResult(voucher);
      requests.set(idempotencyKey, { fingerprint, result });

      if (mode === 'timeout_after_authorize') {
        mode = 'ok';
        return { status: 'retryable', message: TIMEOUT_MESSAGE, outcomeUnknown: true };
      }
      return result;
    },

    findIssued(ref: InvoiceRef): Promise<IssueResult | null> {
      if (mode === 'down') {
        return Promise.resolve({
          status: 'retryable',
          message: SERVICE_DOWN_MESSAGE,
          outcomeUnknown: false,
        });
      }
      const found = vouchers.find(
        (voucher) =>
          voucher.issuerCuit === ref.issuerCuit &&
          voucher.pointOfSale === ref.pointOfSale &&
          voucher.type === ref.type &&
          voucher.number === ref.number,
      );
      return Promise.resolve(found ? issuedResult(found) : null);
    },
  };
}
