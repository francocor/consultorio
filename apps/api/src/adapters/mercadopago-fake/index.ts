import { randomBytes } from 'node:crypto';

import type { PaymentsSimulatorMode } from '@consultorio/contracts';

import type {
  CancelPreapprovalResult,
  CreatePaymentLinkResult,
  CreatePreapprovalResult,
  PaymentDescription,
  PaymentLinkDescription,
  PaymentLinkRequest,
  PaymentLinkSearch,
  PaymentLookup,
  PaymentSearch,
  PaymentSearchQuery,
  PaymentsGateway,
  PreapprovalDescription,
  PreapprovalLookup,
  PreapprovalRequest,
  PreapprovalSearch,
  RefundDescription,
  RefundRequest,
  RefundResult,
  UpdatePreapprovalAmountRequest,
  UpdatePreapprovalAmountResult,
  WebhookHeaders,
  WebhookVerification,
  WebhookVerificationOptions,
} from '../../modules/subscriptions/application/ports.js';

import {
  AMOUNT_CHANGE_REFUSED_MESSAGE,
  FAKE_PAYMENT_METHOD_LABEL,
  KEY_REUSED_MESSAGE,
  NOT_AUTHORIZED_MESSAGE,
  NOT_REFUNDABLE_MESSAGE,
  REFUND_EXCEEDS_MESSAGE,
  SERVICE_DOWN_MESSAGE,
  TIMEOUT_MESSAGE,
  UNKNOWN_PAYMENT_MESSAGE,
  UNKNOWN_PREAPPROVAL_MESSAGE,
  checkoutUrlFor,
  identifierFor,
  isValidAmount,
  paymentLinkProblem,
  preapprovalProblem,
  requestFingerprint,
} from './mp-rules.js';
import { signWebhook, verifyMercadoPagoWebhook } from './mp-signature.js';

/**
 * The in-memory payments gateway for demo organizations and unit tests (design section 6: "Fake").
 * It is written to be hard on its caller, as the real provider is: it can be NOT idempotent (a
 * resent write makes a second resource), it can lose the answer of a write it applied, it can hold
 * a request in flight and let it land after the caller gave up, and it can refuse to change the
 * amount of a live authorization. The local Mercado Pago simulator (Track A, `adapters/mercadopago-local`)
 * keeps the same state in Postgres; both pass `adapters/payments-gateway.contract.ts`.
 *
 * It carries `simulated: true`: the subscriptions module reads it to say "simulated" on every
 * screen. The hosted pages it hands out are on a host that never resolves.
 */

export interface FakePaymentsGatewayOptions {
  /** Whether a resent write with the same key gives the same resource. Default true. */
  idempotent?: boolean;
  /** The secret that signs the notices. Default: a random one per gateway. */
  secret?: string;
  clock?: () => Date;
  /** What `settleWindowMs` says. Default one minute. */
  settleWindowMs?: number;
}

export interface FakeHold {
  release(): void;
  /** Resolves once a write is waiting. */
  entered: Promise<void>;
}

export interface FakeHoldOptions {
  /**
   * The write lands at `release()` even if its caller gave up in the meantime (aborted), like a
   * request the transport could not take back. Without it, an aborted write never lands.
   */
  completeLate?: boolean;
}

export interface FakePaymentsGateway extends PaymentsGateway {
  readonly simulated: true;
  readonly secret: string;
  mode(): PaymentsSimulatorMode;
  setMode(mode: PaymentsSimulatorMode): void;
  /** What the payer does on the hosted page of a preapproval: authorizes it (and the new amount, if one waits). */
  authorize(preapprovalId: string): void;
  /** The billing cycle for an authorized preapproval: the provider charges the payer. */
  chargeCycle(preapprovalId: string, outcome: 'approved' | 'rejected'): PaymentDescription;
  /** What the payer does on the hosted page of a payment link: pays it. */
  payLink(linkId: string): PaymentDescription;
  /** A notice as the provider would send it for `body`, signed now (or at `ts`). */
  sign(body: string, ts?: number): { rawBody: string; headers: Record<string, string> };
  /** Holds the next writes until `release()` (a provider that is slow). */
  hold(options?: FakeHoldOptions): FakeHold;
  preapprovals(): readonly PreapprovalDescription[];
  paymentLinks(): readonly PaymentLinkDescription[];
  payments(): readonly PaymentDescription[];
  /** Forgets everything and goes back to the `ok` mode. */
  reset(): void;
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

type Retryable = { status: 'retryable'; message: string; outcomeUnknown: boolean };

interface PreapprovalState extends PreapprovalDescription {
  /** The amount the payer was asked to authorize again; applied when they do. */
  pendingAmountCents?: number;
}

const copy = <T extends object>(value: T): T => structuredClone(value);

function describePreapproval(state: PreapprovalState): PreapprovalDescription {
  const description: PreapprovalDescription & { pendingAmountCents?: number } = copy(state);
  delete description.pendingAmountCents;
  return description;
}

export function createFakePaymentsGateway(
  options: FakePaymentsGatewayOptions = {},
): FakePaymentsGateway {
  const idempotent = options.idempotent ?? true;
  const secret = options.secret ?? randomBytes(24).toString('base64url');
  const clock = options.clock ?? (() => new Date());
  const settleWindowMs = options.settleWindowMs ?? 60_000;

  let mode: PaymentsSimulatorMode = 'ok';
  let sequence = 0;
  let preapprovals = new Map<string, PreapprovalState>();
  let links = new Map<string, PaymentLinkDescription>();
  let payments = new Map<string, PaymentDescription>();
  /** What a key already did, consulted only when the gateway honours the key. */
  let keyed = new Map<string, { fingerprint: string; result: unknown }>();
  let held: { gate: Promise<void>; completeLate: boolean; enter: () => void } | null = null;
  let requestSequence = 0;

  const next = () => (sequence += 1);
  const nowIso = () => clock().toISOString();

  /**
   * One write: refuses while down, waits for a hold (giving up when the caller aborts, unless the
   * hold lets it land late), applies, and loses the answer once when asked to.
   */
  async function write<R extends { status: string }>(
    apply: () => R,
    signal: AbortSignal | undefined,
  ): Promise<R | Retryable> {
    if (signal?.aborted) throw abortError();
    if (mode === 'down') {
      return { status: 'retryable', message: SERVICE_DOWN_MESSAGE, outcomeUnknown: false };
    }
    if (held) {
      const { gate, completeLate, enter } = held;
      enter();
      if (signal) {
        try {
          await waitFor(gate, signal);
        } catch (error) {
          if (completeLate) {
            void gate.then(() => {
              apply();
            });
          }
          throw error;
        }
      } else {
        await gate;
      }
    }
    const applied = apply();
    if (mode === 'lose_answer' && applied.status !== 'rejected') {
      mode = 'ok';
      return { status: 'retryable', message: TIMEOUT_MESSAGE, outcomeUnknown: true };
    }
    return applied;
  }

  /** Runs `apply` once per key when the gateway honours keys, and always when it does not. */
  function once<R>(key: string, fingerprint: string, apply: () => R, refused: () => R): R {
    if (!idempotent) return apply();
    const known = keyed.get(key);
    if (known) return known.fingerprint === fingerprint ? (known.result as R) : refused();
    const result = apply();
    keyed.set(key, { fingerprint, result });
    return result;
  }

  const down = (): Retryable => ({
    status: 'retryable',
    message: SERVICE_DOWN_MESSAGE,
    outcomeUnknown: false,
  });

  function paymentOf(id: string): PaymentDescription | undefined {
    return payments.get(id);
  }

  const gateway: FakePaymentsGateway = {
    simulated: true,
    secret,
    honoursIdempotencyKey: idempotent,
    settleWindowMs,
    mode: () => mode,
    setMode(value) {
      mode = value;
    },
    reset() {
      mode = 'ok';
      sequence = 0;
      preapprovals = new Map();
      links = new Map();
      payments = new Map();
      keyed = new Map();
      held = null;
    },
    preapprovals: () => [...preapprovals.values()].map(describePreapproval),
    paymentLinks: () => [...links.values()].map((link) => copy(link)),
    payments: () => [...payments.values()].map((payment) => copy(payment)),

    hold(holdOptions = {}) {
      let release!: () => void;
      let enter!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      held = { gate, completeLate: holdOptions.completeLate === true, enter };
      return {
        release() {
          held = null;
          release();
        },
        entered,
      };
    },

    authorize(preapprovalId) {
      const state = preapprovals.get(preapprovalId);
      if (!state) throw new Error(UNKNOWN_PREAPPROVAL_MESSAGE);
      state.status = 'authorized';
      state.paymentMethodLabel = FAKE_PAYMENT_METHOD_LABEL;
      state.nextChargeAt = new Date(clock().getTime() + 30 * 86_400_000).toISOString();
      delete state.checkoutUrl;
      if (state.pendingAmountCents !== undefined) {
        state.amountCents = state.pendingAmountCents;
        delete state.pendingAmountCents;
      }
    },

    chargeCycle(preapprovalId, outcome) {
      const state = preapprovals.get(preapprovalId);
      if (state?.status !== 'authorized') throw new Error(NOT_AUTHORIZED_MESSAGE);
      const payment: PaymentDescription = {
        paymentId: identifierFor('PAY', next()),
        externalReference: state.externalReference,
        preapprovalId,
        amountCents: state.amountCents,
        currency: 'ARS',
        status: outcome === 'approved' ? 'approved' : 'rejected',
        refundedCents: 0,
        refunds: [],
        ...(outcome === 'approved' ? { approvedAt: nowIso() } : {}),
        createdAt: nowIso(),
      };
      payments.set(payment.paymentId, payment);
      return copy(payment);
    },

    payLink(linkId) {
      const link = links.get(linkId);
      if (!link) throw new Error('El proveedor no tiene un enlace de pago con ese identificador.');
      const payment: PaymentDescription = {
        paymentId: identifierFor('PAY', next()),
        externalReference: link.externalReference,
        linkId,
        amountCents: link.amountCents,
        currency: 'ARS',
        status: 'approved',
        refundedCents: 0,
        refunds: [],
        approvedAt: nowIso(),
        createdAt: nowIso(),
      };
      payments.set(payment.paymentId, payment);
      return copy(payment);
    },

    sign(body, ts) {
      requestSequence += 1;
      return signWebhook({
        secret,
        body,
        requestId: `fake-request-${String(requestSequence)}`,
        ts: ts ?? clock().getTime(),
      });
    },

    createPreapproval(
      request: PreapprovalRequest,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<CreatePreapprovalResult> {
      const fingerprint = requestFingerprint('preapproval', [
        request.externalReference,
        request.payerEmail,
        request.amountCents,
        request.currency,
        request.reason,
        request.backUrl,
      ]);
      const apply = (): CreatePreapprovalResult => {
        const problem = preapprovalProblem(request);
        if (problem !== null) return { status: 'rejected', message: problem };
        return once<CreatePreapprovalResult>(
          idempotencyKey,
          fingerprint,
          () => {
            const preapprovalId = identifierFor('PRE', next());
            const state: PreapprovalState = {
              preapprovalId,
              externalReference: request.externalReference,
              payerEmail: request.payerEmail,
              amountCents: request.amountCents,
              currency: 'ARS',
              status: 'pending',
              checkoutUrl: checkoutUrlFor('preapproval', preapprovalId),
              createdAt: nowIso(),
            };
            preapprovals.set(preapprovalId, state);
            return { status: 'created', preapproval: describePreapproval(state) };
          },
          () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
        );
      };
      return write(apply, signal);
    },

    getPreapproval(preapprovalId): Promise<PreapprovalLookup> {
      if (mode === 'down') return Promise.resolve(down());
      const state = preapprovals.get(preapprovalId);
      return Promise.resolve(
        state
          ? { status: 'found', preapproval: describePreapproval(state) }
          : { status: 'unknown' },
      );
    },

    findPreapprovalsByReference(externalReference): Promise<PreapprovalSearch> {
      if (mode === 'down') return Promise.resolve(down());
      return Promise.resolve({
        status: 'ok',
        preapprovals: [...preapprovals.values()]
          .filter((state) => state.externalReference === externalReference)
          .map(describePreapproval),
      });
    },

    updatePreapprovalAmount(
      request: UpdatePreapprovalAmountRequest,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<UpdatePreapprovalAmountResult> {
      const fingerprint = requestFingerprint('amount', [
        request.preapprovalId,
        request.amountCents,
        request.externalReference,
      ]);
      const apply = (): UpdatePreapprovalAmountResult =>
        once<UpdatePreapprovalAmountResult>(
          idempotencyKey,
          fingerprint,
          () => {
            const state = preapprovals.get(request.preapprovalId);
            if (!state) return { status: 'rejected', message: UNKNOWN_PREAPPROVAL_MESSAGE };
            if (!isValidAmount(request.amountCents)) {
              return { status: 'rejected', message: AMOUNT_CHANGE_REFUSED_MESSAGE };
            }
            if (state.status !== 'authorized') {
              return { status: 'rejected', message: NOT_AUTHORIZED_MESSAGE };
            }
            if (mode === 'refuse_amount_change') {
              return { status: 'amount_change_refused', message: AMOUNT_CHANGE_REFUSED_MESSAGE };
            }
            if (mode === 'reauthorize') {
              state.pendingAmountCents = request.amountCents;
              return {
                status: 'reauthorization_required',
                checkoutUrl: checkoutUrlFor('preapproval', state.preapprovalId),
              };
            }
            state.amountCents = request.amountCents;
            return { status: 'updated', preapproval: describePreapproval(state) };
          },
          () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
        );
      return write(apply, signal);
    },

    cancelPreapproval(
      preapprovalId: string,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<CancelPreapprovalResult> {
      const fingerprint = requestFingerprint('cancel', [preapprovalId]);
      const apply = (): CancelPreapprovalResult =>
        once<CancelPreapprovalResult>(
          idempotencyKey,
          fingerprint,
          () => {
            const state = preapprovals.get(preapprovalId);
            if (!state) return { status: 'rejected', message: UNKNOWN_PREAPPROVAL_MESSAGE };
            state.status = 'cancelled';
            delete state.checkoutUrl;
            return { status: 'cancelled', preapproval: describePreapproval(state) };
          },
          () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
        );
      return write(apply, signal);
    },

    createPaymentLink(
      request: PaymentLinkRequest,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<CreatePaymentLinkResult> {
      const fingerprint = requestFingerprint('link', [
        request.externalReference,
        request.payerEmail,
        request.amountCents,
        request.currency,
        request.title,
        request.backUrl,
        request.expiresAt,
      ]);
      const apply = (): CreatePaymentLinkResult => {
        const problem = paymentLinkProblem(request, clock());
        if (problem !== null) return { status: 'rejected', message: problem };
        return once<CreatePaymentLinkResult>(
          idempotencyKey,
          fingerprint,
          () => {
            const linkId = identifierFor('LNK', next());
            const link: PaymentLinkDescription = {
              linkId,
              externalReference: request.externalReference,
              payerEmail: request.payerEmail,
              amountCents: request.amountCents,
              currency: 'ARS',
              url: checkoutUrlFor('link', linkId),
              expiresAt: request.expiresAt,
            };
            links.set(linkId, link);
            return { status: 'created', link: copy(link) };
          },
          () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
        );
      };
      return write(apply, signal);
    },

    findPaymentLinksByReference(externalReference): Promise<PaymentLinkSearch> {
      if (mode === 'down') return Promise.resolve(down());
      return Promise.resolve({
        status: 'ok',
        links: [...links.values()]
          .filter((link) => link.externalReference === externalReference)
          .map((link) => copy(link)),
      });
    },

    getPayment(paymentId): Promise<PaymentLookup> {
      if (mode === 'down') return Promise.resolve(down());
      const payment = paymentOf(paymentId);
      return Promise.resolve(
        payment ? { status: 'found', payment: copy(payment) } : { status: 'unknown' },
      );
    },

    findPayments(query: PaymentSearchQuery): Promise<PaymentSearch> {
      if (mode === 'down') return Promise.resolve(down());
      const found = [...payments.values()].filter(
        (payment) =>
          (query.preapprovalId === undefined || payment.preapprovalId === query.preapprovalId) &&
          (query.externalReference === undefined ||
            payment.externalReference === query.externalReference),
      );
      return Promise.resolve({
        status: 'ok',
        payments:
          query.preapprovalId === undefined && query.externalReference === undefined
            ? []
            : found.map((payment) => copy(payment)),
      });
    },

    refund(
      request: RefundRequest,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<RefundResult> {
      const fingerprint = requestFingerprint('refund', [request.paymentId, request.amountCents]);
      const apply = (): RefundResult =>
        once<RefundResult>(
          idempotencyKey,
          fingerprint,
          () => {
            const payment = paymentOf(request.paymentId);
            if (!payment) return { status: 'rejected', message: UNKNOWN_PAYMENT_MESSAGE };
            if (payment.status !== 'approved' && payment.status !== 'partially_refunded') {
              return { status: 'rejected', message: NOT_REFUNDABLE_MESSAGE };
            }
            if (!isValidAmount(request.amountCents)) {
              return { status: 'rejected', message: REFUND_EXCEEDS_MESSAGE };
            }
            if (request.amountCents > payment.amountCents - payment.refundedCents) {
              return { status: 'rejected', message: REFUND_EXCEEDS_MESSAGE };
            }
            const refund: RefundDescription = {
              refundId: identifierFor('RFD', next()),
              amountCents: request.amountCents,
              createdAt: nowIso(),
            };
            const refunded = payment.refundedCents + request.amountCents;
            const updated: PaymentDescription = {
              ...payment,
              refundedCents: refunded,
              refunds: [...payment.refunds, refund],
              status: refunded === payment.amountCents ? 'refunded' : 'partially_refunded',
            };
            payments.set(payment.paymentId, updated);
            return { status: 'refunded', payment: copy(updated), refund: copy(refund) };
          },
          () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
        );
      return write(apply, signal);
    },

    verifyWebhook(
      rawBody: string | Uint8Array,
      headers: WebhookHeaders,
      verification: WebhookVerificationOptions = {},
    ): WebhookVerification {
      return verifyMercadoPagoWebhook({
        secret,
        rawBody,
        headers,
        now: verification.now ?? clock(),
        ...(verification.toleranceMs === undefined
          ? {}
          : { toleranceMs: verification.toleranceMs }),
      });
    },
  };

  return gateway;
}
