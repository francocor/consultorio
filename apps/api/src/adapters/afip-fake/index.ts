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
  /** The organization the voucher belongs to (`''` when the request names none). */
  tenantRef: string;
  issuerCuit: string;
  pointOfSale: number;
  type: string;
  number: number;
  cae: string;
  caeExpiresOn: string;
  issueDate: string;
  totalCents: number;
  /** Whom the voucher is addressed to, and (a credit note) the voucher it cancels: a lookup says them. */
  buyerDocument: { type: 'cuit' | 'dni'; number: string } | null;
  associatedVoucher: { type: string; pointOfSale: number; number: number } | null;
  idempotencyKey: string;
}

export interface FakeInvoiceIssuer extends InvoiceIssuer {
  readonly simulated: true;
  mode(): AfipSimulatorMode;
  setMode(mode: AfipSimulatorMode): void;
  /** Everything issued, oldest first. */
  vouchers(): readonly FakeVoucher[];
  /**
   * Test only: whether the same idempotency key gets the same voucher (the default). The real
   * authority does not take our key: it issues a new voucher on every request. With `false` every call
   * of `issue` issues a new voucher, so a request sent twice shows as two vouchers.
   */
  setIdempotent(idempotent: boolean): void;
  /** Forgets every voucher and goes back to the `ok` mode, idempotent. */
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
  let idempotent = true;
  let vouchers: FakeVoucher[] = [];
  let requests = new Map<string, Stored>();

  const lastNumber = (request: InvoiceRequest) =>
    vouchers
      .filter(
        (voucher) =>
          voucher.tenantRef === (request.tenantRef ?? '') &&
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
    totalCents: voucher.totalCents,
    issueDate: voucher.issueDate,
    issuerCuit: voucher.issuerCuit,
    buyerDocument: voucher.buyerDocument,
    associatedVoucher: voucher.associatedVoucher,
  });

  return {
    simulated: true,
    mode: () => mode,
    setMode(next) {
      mode = next;
    },
    vouchers: () => [...vouchers],
    setIdempotent(next) {
      idempotent = next;
    },
    reset() {
      mode = 'ok';
      idempotent = true;
      vouchers = [];
      requests = new Map();
    },

    async issue(request, idempotencyKey): Promise<IssueResult> {
      if (mode === 'down') {
        return { status: 'retryable', message: SERVICE_DOWN_MESSAGE, outcomeUnknown: false };
      }
      const fingerprint = requestFingerprint(request);
      const tenantRef = request.tenantRef ?? '';
      // An answer is remembered per organization: the same key from another one is a new request.
      const requestKey = `${tenantRef}|${idempotencyKey}`;
      const known = idempotent ? requests.get(requestKey) : undefined;
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
        requests.set(requestKey, { fingerprint, result });
        return result;
      }

      const identity = {
        tenantRef,
        issuerCuit: request.issuerCuit ?? '',
        pointOfSale: request.pointOfSale,
        type: request.type,
        // After what this process issued and after what the organization says it holds: a fake
        // that restarted does not number a voucher that already exists.
        number: Math.max(lastNumber(request), request.lastKnownNumber ?? 0) + 1,
      };
      const voucher: FakeVoucher = {
        ...identity,
        cae: caeFor(identity),
        caeExpiresOn: caeExpiresOn(request.issueDate),
        issueDate: request.issueDate,
        totalCents: request.totalCents,
        buyerDocument: request.buyerDocument ?? null,
        associatedVoucher: request.associatedVoucher ?? null,
        idempotencyKey,
      };
      vouchers.push(voucher);
      const result = issuedResult(voucher);
      requests.set(requestKey, { fingerprint, result });

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
          voucher.tenantRef === (ref.tenantRef ?? '') &&
          voucher.issuerCuit === ref.issuerCuit &&
          voucher.pointOfSale === ref.pointOfSale &&
          voucher.type === ref.type &&
          voucher.number === ref.number,
      );
      return Promise.resolve(found ? issuedResult(found) : null);
    },
  };
}
