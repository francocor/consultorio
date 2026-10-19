import type {
  AfipSimulatorMode,
  InvoiceIssuer,
  InvoiceRef,
  InvoiceRequest,
  InvoiceSeriesRef,
  IssueResult,
  LastAuthorizedResult,
} from '@consultorio/contracts';

import {
  DEFAULT_SLOW_MS,
  KEY_REUSED_MESSAGE,
  NOT_NEXT_MESSAGE,
  SERVICE_DOWN_MESSAGE,
  SIMULATED_REJECTION_MESSAGE,
  TIMEOUT_MESSAGE,
  caeExpiresOn,
  caeFor,
  isNextNumber,
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
 * A request pinned to a number (`expectedNumber`) is served only if that is the next number of its series,
 * like the authority does (JD-S4 R6-1); otherwise it answers `not_next` and issues nothing.
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
  /**
   * Test only: the next request that reaches the authority is still being processed when the caller gives
   * up on it. The caller is told "timed out, outcome unknown" at once and the voucher appears only when
   * `releaseHeld` runs, which models a request that finishes AFTER the caller looked for it
   * (JD-S4 R6-1).
   */
  holdNext(): void;
  /** Finishes the requests held, in the order they arrived, and returns what the authority answered each. */
  releaseHeld(): Promise<IssueResult[]>;
  /** Forgets the requests held without finishing them (a request the authority never processed). */
  dropHeld(): void;
  /**
   * Tells the fake where to learn what the organization holds when its own memory is empty (a restart
   * of the process): the first time it is asked about a series it numbers after `held(series)` as well.
   * The real authority has no such need; this is only so the in-memory issuer of the demo does not
   * restart its numbering below vouchers that exist. `reset()` keeps it: it is wiring, not memory.
   */
  rememberFrom(held: HeldNumbers | undefined): void;
}

/** The highest number the organization records for a point of sale and type, or 0. */
export type HeldNumbers = (series: {
  tenantRef: string;
  pointOfSale: number;
  type: string;
}) => Promise<number>;

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
  let holdNext = false;
  let held: (() => Promise<IssueResult>)[] = [];
  let heldNumbers: HeldNumbers | undefined;
  /** What the organization held, per series, the first time this process was asked about it. */
  let baselines = new Map<string, number>();

  type Series = Pick<InvoiceSeriesRef, 'tenantRef' | 'issuerCuit' | 'pointOfSale' | 'type'>;
  const seriesKey = (series: Series) =>
    [series.tenantRef ?? '', series.issuerCuit ?? '', series.pointOfSale, series.type].join('|');

  /** Loads, once per series, the numbers the organization holds that this process does not remember. */
  const remember = async (series: Series): Promise<void> => {
    const key = seriesKey(series);
    if (!heldNumbers || baselines.has(key)) return;
    baselines.set(
      key,
      await heldNumbers({
        tenantRef: series.tenantRef ?? '',
        pointOfSale: series.pointOfSale,
        type: series.type,
      }),
    );
  };

  /** Synchronous: `remember` has run before it, so nothing can interleave between reading and writing. */
  const lastNumber = (series: Series) =>
    vouchers
      .filter(
        (voucher) =>
          voucher.tenantRef === (series.tenantRef ?? '') &&
          voucher.issuerCuit === (series.issuerCuit ?? '') &&
          voucher.pointOfSale === series.pointOfSale &&
          voucher.type === series.type,
      )
      .reduce(
        (highest, voucher) => Math.max(highest, voucher.number),
        baselines.get(seriesKey(series)) ?? 0,
      );

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

  /** What the authority does with a request once it reaches it. */
  const handle = async (request: InvoiceRequest, idempotencyKey: string): Promise<IssueResult> => {
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

    const rejection = mode === 'reject_next' ? SIMULATED_REJECTION_MESSAGE : rejectionFor(request);
    if (mode === 'reject_next') mode = 'ok';
    if (rejection !== null) {
      const result: Decided = { status: 'rejected', message: rejection };
      requests.set(requestKey, { fingerprint, result });
      return result;
    }

    await remember(request);
    // A request pinned to a number is served only if it is the next one: nothing is issued, and nothing
    // is remembered under the key (the refusal is not an answer to the request).
    const last = lastNumber(request);
    if (!isNextNumber(request, last)) {
      return { status: 'not_next', message: NOT_NEXT_MESSAGE };
    }
    const identity = {
      tenantRef,
      issuerCuit: request.issuerCuit ?? '',
      pointOfSale: request.pointOfSale,
      type: request.type,
      number: last + 1,
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
  };

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
      baselines = new Map();
      held = [];
      holdNext = false;
    },
    holdNext() {
      holdNext = true;
    },
    async releaseHeld() {
      const pending = held;
      held = [];
      const results: IssueResult[] = [];
      for (const finish of pending) results.push(await finish());
      return results;
    },
    dropHeld() {
      held = [];
      holdNext = false;
    },
    rememberFrom(next) {
      heldNumbers = next;
      baselines = new Map();
    },

    async issue(request, idempotencyKey): Promise<IssueResult> {
      if (mode === 'down') {
        return { status: 'retryable', message: SERVICE_DOWN_MESSAGE, outcomeUnknown: false };
      }
      if (holdNext) {
        // The caller gives up while the authority is still working on the request.
        holdNext = false;
        held.push(() => handle(request, idempotencyKey));
        return { status: 'retryable', message: TIMEOUT_MESSAGE, outcomeUnknown: true };
      }
      return handle(request, idempotencyKey);
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

    async lastAuthorized(series: InvoiceSeriesRef): Promise<LastAuthorizedResult> {
      if (mode === 'down') {
        return { status: 'retryable', message: SERVICE_DOWN_MESSAGE, outcomeUnknown: false };
      }
      await remember(series);
      // Whatever was issued in the series counts, whoever asked for it; an empty series is 0.
      return { status: 'ok', number: lastNumber(series) };
    },
  };
}
