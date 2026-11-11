import { randomBytes } from 'node:crypto';

import type { PaymentsSimulatorMode } from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import {
  localMpControl,
  localMpLink,
  localMpPayment,
  localMpPreapproval,
  localMpRequest,
  type LocalMpLinkRow,
  type LocalMpPaymentRow,
  type LocalMpPreapprovalRow,
} from '../../db/schema/local-mercadopago.js';
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
  RefundRequest,
  RefundResult,
  UpdatePreapprovalAmountRequest,
  UpdatePreapprovalAmountResult,
  WebhookHeaders,
  WebhookVerification,
  WebhookVerificationOptions,
} from '../../modules/subscriptions/application/ports.js';
import type { Db } from '../../platform/db/pool.js';
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
  isValidAmount,
  paymentLinkProblem,
  preapprovalProblem,
  requestFingerprint,
} from '../mercadopago-fake/mp-rules.js';
import { signWebhook, verifyMercadoPagoWebhook } from '../mercadopago-fake/mp-signature.js';

/**
 * The local Mercado Pago simulator (`PAYMENTS_PROVIDER=local`): a working payments provider that
 * needs no account and no network. It keeps its preapprovals, links, payments and mode in Postgres,
 * so the API and the worker see the same one, and it behaves like the real provider where it matters
 * to the product:
 *
 * - it is NOT idempotent unless told to be (`idempotent: true`): a resent write with the same key
 *   makes a second preapproval, link or refund, like the real preapproval endpoint, and the search by
 *   reference shows both. The subscriptions module is written for that provider;
 * - a preapproval waits for the payer on a hosted page (`/local-providers/mercadopago/checkout/:id`)
 *   where they approve, reject, leave it pending or abandon it; nothing is authorized until they do;
 * - it charges an authorized preapproval when the billing cycle runs, approved or rejected, and it
 *   signs and posts its notices to the application's own webhook with the manifest of Mercado Pago;
 * - modes: `ok`, `down` (retryable, nothing happens), `lose_answer` (applies the write, then answers
 *   "unknown outcome"; fires once), `refuse_amount_change`, `reauthorize` (the new amount waits for
 *   the payer), and `duplicate_events` and `out_of_order` (how the notices are delivered).
 *
 * It carries `simulated: true`: the subscriptions module reads it to say "simulated" on every screen.
 */

export interface LocalPaymentsGateway extends PaymentsGateway {
  readonly simulated: true;
  /** The secret that signs the notices; the webhook of the application verifies with it. */
  readonly secret: string;
  /** A notice as the provider would send it for `body`, signed now (or at `ts`). */
  sign(body: string, ts?: number): { rawBody: string; headers: Record<string, string> };
  /** The hosted page of a preapproval or a link. */
  hostedPageOf(kind: 'preapproval' | 'link', id: string): string;
  /** Whether the hosted pages are served (`LOCAL_PROVIDERS_CONSOLE`). */
  readonly hostedCheckout: boolean;
  /** What the hosted pages and the provider console do with the state of the simulator. */
  readonly controls: LocalPaymentsControls;
}

export interface LocalPaymentsGatewayOptions {
  db: Db;
  /** Signs and verifies the notices. At least 16 characters in production; a process secret in development. */
  webhookSecret: string;
  /** Where the hosted pages are reached from outside (`MP_PUBLIC_BASE_URL`, or the platform host). */
  publicBaseUrl: string;
  /** Whether a resent write with the same key gives the same resource. Default false, like Mercado Pago. */
  idempotent?: boolean;
  clock?: () => Date;
  /** What `settleWindowMs` says. Default one minute. */
  settleWindowMs?: number;
  /** Whether the application serves the hosted pages (the provider console is on). Default false. */
  hostedCheckout?: boolean;
}

const CHECKOUT_PATH = '/local-providers/mercadopago/checkout';

/** The address of the hosted page of a resource of the simulator. */
export function hostedPageUrl(publicBaseUrl: string, id: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${CHECKOUT_PATH}/${encodeURIComponent(id)}`;
}

const newIdentifier = (prefix: 'PRE' | 'PAY' | 'LNK' | 'RFD') =>
  `${prefix}-${randomBytes(6).toString('hex').toUpperCase()}`;

/** The single control row, created on first use. */
async function readControl(db: Pick<Db, 'insert' | 'select'>) {
  await db.insert(localMpControl).values({ id: 1 }).onConflictDoNothing();
  const [row] = await db.select().from(localMpControl).where(eq(localMpControl.id, 1));
  if (!row) throw new Error('the simulator control row is missing');
  return row;
}

type Retryable = { status: 'retryable'; message: string; outcomeUnknown: boolean };

const down = (): Retryable => ({
  status: 'retryable',
  message: SERVICE_DOWN_MESSAGE,
  outcomeUnknown: false,
});

const lost = (): Retryable => ({
  status: 'retryable',
  message: TIMEOUT_MESSAGE,
  outcomeUnknown: true,
});

const iso = (value: Date) => value.toISOString();

export function createLocalPaymentsGateway(
  options: LocalPaymentsGatewayOptions,
): LocalPaymentsGateway {
  const { db } = options;
  const idempotent = options.idempotent ?? false;
  const clock = options.clock ?? (() => new Date());
  const settleWindowMs = options.settleWindowMs ?? 60_000;
  let requestSequence = 0;

  function describePreapproval(row: LocalMpPreapprovalRow): PreapprovalDescription {
    return {
      preapprovalId: row.preapprovalId,
      externalReference: row.externalReference,
      payerEmail: row.payerEmail,
      amountCents: row.amountCents,
      currency: 'ARS',
      status: row.status as PreapprovalDescription['status'],
      ...(row.status === 'pending'
        ? { checkoutUrl: hostedPageUrl(options.publicBaseUrl, row.preapprovalId) }
        : {}),
      ...(row.paymentMethodLabel === null ? {} : { paymentMethodLabel: row.paymentMethodLabel }),
      ...(row.nextChargeAt === null ? {} : { nextChargeAt: iso(row.nextChargeAt) }),
      createdAt: iso(row.createdAt),
    };
  }

  function describeLink(row: LocalMpLinkRow): PaymentLinkDescription {
    return {
      linkId: row.linkId,
      externalReference: row.externalReference,
      payerEmail: row.payerEmail,
      amountCents: row.amountCents,
      currency: 'ARS',
      url: hostedPageUrl(options.publicBaseUrl, row.linkId),
      expiresAt: iso(row.expiresAt),
    };
  }

  function describePayment(row: LocalMpPaymentRow): PaymentDescription {
    return {
      paymentId: row.paymentId,
      externalReference: row.externalReference,
      ...(row.preapprovalId === null ? {} : { preapprovalId: row.preapprovalId }),
      ...(row.linkId === null ? {} : { linkId: row.linkId }),
      amountCents: row.amountCents,
      currency: 'ARS',
      status: row.status as PaymentDescription['status'],
      refundedCents: row.refundedCents,
      refunds: row.refunds,
      ...(row.approvedAt === null ? {} : { approvedAt: iso(row.approvedAt) }),
      createdAt: iso(row.createdAt),
    };
  }

  /** Consumes a one-shot mode: true for the one write that finds it still set. */
  async function fire(mode: PaymentsSimulatorMode): Promise<boolean> {
    const fired = await db
      .update(localMpControl)
      .set({ mode: 'ok' })
      .where(and(eq(localMpControl.id, 1), eq(localMpControl.mode, mode)))
      .returning({ id: localMpControl.id });
    return fired.length > 0;
  }

  /** The same key never runs twice at once: the second waits for the first and then reads its answer. */
  const keyLock = (tx: Pick<Db, 'execute'>, epoch: number, key: string) =>
    tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`mp-key|${String(epoch)}|${key}`}, 0))`,
    );

  type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

  /**
   * One write: refuses while down; runs `apply` in a transaction that leaves nothing behind when the
   * caller stopped waiting; consults the answer to the key when the simulator honours keys; and loses
   * the answer once when asked to.
   */
  async function write<R extends { status: string }>(
    kind: string,
    key: string,
    fingerprint: string,
    signal: AbortSignal | undefined,
    apply: (tx: Tx, epoch: number, mode: PaymentsSimulatorMode) => Promise<R>,
    refused: () => R,
  ): Promise<R | Retryable> {
    signal?.throwIfAborted();
    const control = await readControl(db);
    if (control.mode === 'down') return down();
    const { epoch } = control;
    const mode = control.mode as PaymentsSimulatorMode;

    const result = await db.transaction(async (tx): Promise<R> => {
      if (idempotent) {
        await keyLock(tx, epoch, key);
        const [known] = await tx
          .select()
          .from(localMpRequest)
          .where(and(eq(localMpRequest.epoch, epoch), eq(localMpRequest.idempotencyKey, key)));
        if (known) {
          return known.kind === kind && known.fingerprint === fingerprint
            ? (known.result as unknown as R)
            : refused();
        }
      }
      // Nobody waits any more: leave nothing behind (the transaction rolls back).
      signal?.throwIfAborted();
      const applied = await apply(tx, epoch, mode);
      if (idempotent) {
        await tx.insert(localMpRequest).values({
          epoch,
          idempotencyKey: key,
          kind,
          fingerprint,
          result: applied,
        });
      }
      return applied;
    });
    if (mode === 'lose_answer' && result.status !== 'rejected' && (await fire('lose_answer'))) {
      return lost();
    }
    return result;
  }

  async function paymentOf(
    tx: Pick<Db, 'select'>,
    epoch: number,
    paymentId: string,
    forUpdate = false,
  ): Promise<LocalMpPaymentRow | undefined> {
    const query = tx
      .select()
      .from(localMpPayment)
      .where(and(eq(localMpPayment.epoch, epoch), eq(localMpPayment.paymentId, paymentId)));
    const [row] = await (forUpdate ? query.for('update') : query);
    return row;
  }

  const gateway: LocalPaymentsGateway = {
    simulated: true,
    secret: options.webhookSecret,
    honoursIdempotencyKey: idempotent,
    settleWindowMs,
    hostedCheckout: options.hostedCheckout ?? false,
    controls: createLocalPaymentsControls(db, { clock }),

    sign(body, ts) {
      requestSequence += 1;
      return signWebhook({
        secret: options.webhookSecret,
        body,
        requestId: `local-request-${randomBytes(4).toString('hex')}-${String(requestSequence)}`,
        ts: ts ?? clock().getTime(),
      });
    },

    hostedPageOf: (_kind, id) => hostedPageUrl(options.publicBaseUrl, id),

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
      const problem = preapprovalProblem(request);
      if (problem !== null) {
        signal?.throwIfAborted();
        return Promise.resolve({ status: 'rejected', message: problem });
      }
      return write<CreatePreapprovalResult>(
        'preapproval',
        idempotencyKey,
        fingerprint,
        signal,
        async (tx, epoch) => {
          const [created] = await tx
            .insert(localMpPreapproval)
            .values({
              epoch,
              preapprovalId: newIdentifier('PRE'),
              externalReference: request.externalReference,
              payerEmail: request.payerEmail,
              amountCents: request.amountCents,
              status: 'pending',
              backUrl: request.backUrl,
            })
            .returning();
          if (!created) throw new Error('the simulator could not store a preapproval');
          return { status: 'created', preapproval: describePreapproval(created) };
        },
        () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
      );
    },

    async getPreapproval(preapprovalId, signal): Promise<PreapprovalLookup> {
      signal?.throwIfAborted();
      const control = await readControl(db);
      if (control.mode === 'down') return down();
      const [row] = await db
        .select()
        .from(localMpPreapproval)
        .where(
          and(
            eq(localMpPreapproval.epoch, control.epoch),
            eq(localMpPreapproval.preapprovalId, preapprovalId),
          ),
        );
      return row
        ? { status: 'found', preapproval: describePreapproval(row) }
        : { status: 'unknown' };
    },

    async findPreapprovalsByReference(externalReference, signal): Promise<PreapprovalSearch> {
      signal?.throwIfAborted();
      const control = await readControl(db);
      if (control.mode === 'down') return down();
      const rows = await db
        .select()
        .from(localMpPreapproval)
        .where(
          and(
            eq(localMpPreapproval.epoch, control.epoch),
            eq(localMpPreapproval.externalReference, externalReference),
          ),
        )
        .orderBy(localMpPreapproval.createdAt, localMpPreapproval.id);
      return { status: 'ok', preapprovals: rows.map(describePreapproval) };
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
      return write<UpdatePreapprovalAmountResult>(
        'amount',
        idempotencyKey,
        fingerprint,
        signal,
        async (tx, epoch, mode) => {
          const [row] = await tx
            .select()
            .from(localMpPreapproval)
            .where(
              and(
                eq(localMpPreapproval.epoch, epoch),
                eq(localMpPreapproval.preapprovalId, request.preapprovalId),
              ),
            )
            .for('update');
          if (!row) return { status: 'rejected', message: UNKNOWN_PREAPPROVAL_MESSAGE };
          if (!isValidAmount(request.amountCents)) {
            return { status: 'rejected', message: AMOUNT_CHANGE_REFUSED_MESSAGE };
          }
          if (row.status !== 'authorized') {
            return { status: 'rejected', message: NOT_AUTHORIZED_MESSAGE };
          }
          if (mode === 'refuse_amount_change') {
            return { status: 'amount_change_refused', message: AMOUNT_CHANGE_REFUSED_MESSAGE };
          }
          if (mode === 'reauthorize') {
            await tx
              .update(localMpPreapproval)
              .set({ pendingAmountCents: request.amountCents })
              .where(eq(localMpPreapproval.id, row.id));
            return {
              status: 'reauthorization_required',
              checkoutUrl: hostedPageUrl(options.publicBaseUrl, row.preapprovalId),
            };
          }
          const [updated] = await tx
            .update(localMpPreapproval)
            .set({ amountCents: request.amountCents })
            .where(eq(localMpPreapproval.id, row.id))
            .returning();
          if (!updated) throw new Error('the simulator lost a preapproval');
          return { status: 'updated', preapproval: describePreapproval(updated) };
        },
        () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
      );
    },

    cancelPreapproval(
      preapprovalId: string,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<CancelPreapprovalResult> {
      const fingerprint = requestFingerprint('cancel', [preapprovalId]);
      return write<CancelPreapprovalResult>(
        'cancel',
        idempotencyKey,
        fingerprint,
        signal,
        async (tx, epoch) => {
          const [row] = await tx
            .update(localMpPreapproval)
            .set({ status: 'cancelled', pendingAmountCents: null })
            .where(
              and(
                eq(localMpPreapproval.epoch, epoch),
                eq(localMpPreapproval.preapprovalId, preapprovalId),
              ),
            )
            .returning();
          if (!row) return { status: 'rejected', message: UNKNOWN_PREAPPROVAL_MESSAGE };
          return { status: 'cancelled', preapproval: describePreapproval(row) };
        },
        () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
      );
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
      const problem = paymentLinkProblem(request, clock());
      if (problem !== null) {
        signal?.throwIfAborted();
        return Promise.resolve({ status: 'rejected', message: problem });
      }
      return write<CreatePaymentLinkResult>(
        'link',
        idempotencyKey,
        fingerprint,
        signal,
        async (tx, epoch) => {
          const [created] = await tx
            .insert(localMpLink)
            .values({
              epoch,
              linkId: newIdentifier('LNK'),
              externalReference: request.externalReference,
              payerEmail: request.payerEmail,
              amountCents: request.amountCents,
              title: request.title,
              backUrl: request.backUrl,
              expiresAt: new Date(request.expiresAt),
            })
            .returning();
          if (!created) throw new Error('the simulator could not store a payment link');
          return { status: 'created', link: describeLink(created) };
        },
        () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
      );
    },

    async findPaymentLinksByReference(externalReference, signal): Promise<PaymentLinkSearch> {
      signal?.throwIfAborted();
      const control = await readControl(db);
      if (control.mode === 'down') return down();
      const rows = await db
        .select()
        .from(localMpLink)
        .where(
          and(
            eq(localMpLink.epoch, control.epoch),
            eq(localMpLink.externalReference, externalReference),
          ),
        )
        .orderBy(localMpLink.createdAt, localMpLink.id);
      return { status: 'ok', links: rows.map(describeLink) };
    },

    async getPayment(paymentId, signal): Promise<PaymentLookup> {
      signal?.throwIfAborted();
      const control = await readControl(db);
      if (control.mode === 'down') return down();
      const row = await paymentOf(db, control.epoch, paymentId);
      return row ? { status: 'found', payment: describePayment(row) } : { status: 'unknown' };
    },

    async findPayments(query: PaymentSearchQuery, signal): Promise<PaymentSearch> {
      signal?.throwIfAborted();
      const control = await readControl(db);
      if (control.mode === 'down') return down();
      if (query.preapprovalId === undefined && query.externalReference === undefined) {
        return { status: 'ok', payments: [] };
      }
      const rows = await db
        .select()
        .from(localMpPayment)
        .where(
          and(
            eq(localMpPayment.epoch, control.epoch),
            query.preapprovalId === undefined
              ? undefined
              : eq(localMpPayment.preapprovalId, query.preapprovalId),
            query.externalReference === undefined
              ? undefined
              : eq(localMpPayment.externalReference, query.externalReference),
          ),
        )
        .orderBy(localMpPayment.createdAt, localMpPayment.id);
      return { status: 'ok', payments: rows.map(describePayment) };
    },

    refund(
      request: RefundRequest,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<RefundResult> {
      const fingerprint = requestFingerprint('refund', [request.paymentId, request.amountCents]);
      return write<RefundResult>(
        'refund',
        idempotencyKey,
        fingerprint,
        signal,
        async (tx, epoch) => {
          const payment = await paymentOf(tx, epoch, request.paymentId, true);
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
          const refund = {
            refundId: newIdentifier('RFD'),
            amountCents: request.amountCents,
            createdAt: iso(clock()),
          };
          const refunded = payment.refundedCents + request.amountCents;
          const [updated] = await tx
            .update(localMpPayment)
            .set({
              refundedCents: refunded,
              refunds: [...payment.refunds, refund],
              status: refunded === payment.amountCents ? 'refunded' : 'partially_refunded',
            })
            .where(eq(localMpPayment.id, payment.id))
            .returning();
          if (!updated) throw new Error('the simulator lost a payment');
          return { status: 'refunded', payment: describePayment(updated), refund };
        },
        () => ({ status: 'rejected', message: KEY_REUSED_MESSAGE }),
      );
    },

    verifyWebhook(
      rawBody: string | Uint8Array,
      headers: WebhookHeaders,
      verification: WebhookVerificationOptions = {},
    ): WebhookVerification {
      return verifyMercadoPagoWebhook({
        secret: options.webhookSecret,
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

export interface LocalMpPreapprovalListing {
  preapprovalId: string;
  reference: string;
  status: PreapprovalDescription['status'];
  amountCents: number;
  createdAt: Date;
}

export interface LocalMpPaymentListing {
  paymentId: string;
  reference: string;
  status: string;
  amountCents: number;
  refundedCents: number;
  createdAt: Date;
}

/** What the payer does on a hosted page. */
export type CheckoutChoice = 'approve' | 'reject' | 'pending' | 'abandon';

/** What the hosted page of a resource shows: its kind and what to say about it. */
export type HostedResource =
  | {
      kind: 'preapproval';
      id: string;
      amountCents: number;
      status: PreapprovalDescription['status'];
      /** The payer still has something to authorize: a new preapproval, or a new amount. */
      awaitingPayer: boolean;
      backUrl: string;
    }
  | {
      kind: 'link';
      id: string;
      amountCents: number;
      title: string;
      backUrl: string;
      expired: boolean;
    };

/** What the provider console and the hosted pages do with the simulator. */
export interface LocalPaymentsControls {
  mode(): Promise<PaymentsSimulatorMode>;
  setMode(mode: PaymentsSimulatorMode): Promise<void>;
  preapprovals(limit: number): Promise<LocalMpPreapprovalListing[]>;
  payments(limit: number): Promise<LocalMpPaymentListing[]>;
  /** What a hosted page shows, or null when the simulator holds no such resource. */
  hostedResource(id: string): Promise<HostedResource | null>;
  /**
   * What the payer does on a preapproval's page: `approve` authorizes it (and the new amount that
   * waits for them, if any), `reject` cancels it, `pending` and `abandon` leave it as it is. Returns
   * the id of the resource a notice is due about, or null when nothing changed.
   */
  decidePreapproval(id: string, choice: CheckoutChoice): Promise<{ notify: string | null } | null>;
  /**
   * What the payer does on a link's page: `approve` pays it. Returns the payment made, if any.
   */
  decideLink(id: string, choice: CheckoutChoice): Promise<{ paymentId: string | null } | null>;
  /** The provider charges one authorized preapproval now. Returns the payment, or null if it is not authorized. */
  charge(
    preapprovalId: string,
    outcome: 'approved' | 'rejected',
  ): Promise<{ paymentId: string } | null>;
  /** The billing cycle: the provider charges every authorized preapproval now. */
  runBillingCycle(outcome: 'approved' | 'rejected'): Promise<string[]>;
  /** Forgets the resources and the keys and puts the mode back to `ok`. Nothing is deleted. */
  reset(): Promise<void>;
}

const MONTH_MS = 30 * 86_400_000;

export function createLocalPaymentsControls(
  db: Db,
  options: { clock?: () => Date } = {},
): LocalPaymentsControls {
  const clock = options.clock ?? (() => new Date());

  async function insertPayment(
    tx: Pick<Db, 'insert'>,
    epoch: number,
    values: {
      externalReference: string;
      preapprovalId?: string;
      linkId?: string;
      amountCents: number;
      outcome: 'approved' | 'rejected';
    },
  ): Promise<string> {
    const now = clock();
    const paymentId = newIdentifier('PAY');
    await tx.insert(localMpPayment).values({
      epoch,
      paymentId,
      externalReference: values.externalReference,
      preapprovalId: values.preapprovalId ?? null,
      linkId: values.linkId ?? null,
      amountCents: values.amountCents,
      status: values.outcome,
      approvedAt: values.outcome === 'approved' ? now : null,
      createdAt: now,
    });
    return paymentId;
  }

  async function chargePreapproval(
    db2: Db,
    epoch: number,
    row: LocalMpPreapprovalRow,
    outcome: 'approved' | 'rejected',
  ): Promise<string> {
    return db2.transaction(async (tx) => {
      const paymentId = await insertPayment(tx, epoch, {
        externalReference: row.externalReference,
        preapprovalId: row.preapprovalId,
        amountCents: row.amountCents,
        outcome,
      });
      await tx
        .update(localMpPreapproval)
        .set({ nextChargeAt: new Date(clock().getTime() + MONTH_MS) })
        .where(eq(localMpPreapproval.id, row.id));
      return paymentId;
    });
  }

  return {
    async mode() {
      return (await readControl(db)).mode as PaymentsSimulatorMode;
    },
    async setMode(mode) {
      await readControl(db);
      await db.update(localMpControl).set({ mode }).where(eq(localMpControl.id, 1));
    },
    async preapprovals(limit) {
      const { epoch } = await readControl(db);
      const rows = await db
        .select()
        .from(localMpPreapproval)
        .where(eq(localMpPreapproval.epoch, epoch))
        .orderBy(desc(localMpPreapproval.createdAt), desc(localMpPreapproval.id))
        .limit(limit);
      return rows.map((row) => ({
        preapprovalId: row.preapprovalId,
        reference: row.externalReference,
        status: row.status as PreapprovalDescription['status'],
        amountCents: row.amountCents,
        createdAt: row.createdAt,
      }));
    },
    async payments(limit) {
      const { epoch } = await readControl(db);
      const rows = await db
        .select()
        .from(localMpPayment)
        .where(eq(localMpPayment.epoch, epoch))
        .orderBy(desc(localMpPayment.createdAt), desc(localMpPayment.id))
        .limit(limit);
      return rows.map((row) => ({
        paymentId: row.paymentId,
        reference: row.externalReference,
        status: row.status,
        amountCents: row.amountCents,
        refundedCents: row.refundedCents,
        createdAt: row.createdAt,
      }));
    },

    async hostedResource(id) {
      const { epoch } = await readControl(db);
      const [preapproval] = await db
        .select()
        .from(localMpPreapproval)
        .where(and(eq(localMpPreapproval.epoch, epoch), eq(localMpPreapproval.preapprovalId, id)));
      if (preapproval) {
        return {
          kind: 'preapproval',
          id,
          // The amount the payer is asked to authorize: the new one, when one waits.
          amountCents: preapproval.pendingAmountCents ?? preapproval.amountCents,
          status: preapproval.status as PreapprovalDescription['status'],
          awaitingPayer:
            preapproval.status === 'pending' ||
            (preapproval.status === 'authorized' && preapproval.pendingAmountCents !== null),
          backUrl: preapproval.backUrl,
        };
      }
      const [link] = await db
        .select()
        .from(localMpLink)
        .where(and(eq(localMpLink.epoch, epoch), eq(localMpLink.linkId, id)));
      if (link) {
        return {
          kind: 'link',
          id,
          amountCents: link.amountCents,
          title: link.title,
          backUrl: link.backUrl,
          expired: link.expiresAt.getTime() <= clock().getTime(),
        };
      }
      return null;
    },

    async decidePreapproval(id, choice) {
      const { epoch } = await readControl(db);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(localMpPreapproval)
          .where(and(eq(localMpPreapproval.epoch, epoch), eq(localMpPreapproval.preapprovalId, id)))
          .for('update');
        if (!row) return null;
        if (choice === 'abandon' || choice === 'pending') return { notify: null };
        if (choice === 'reject') {
          if (row.status === 'cancelled') return { notify: null };
          await tx
            .update(localMpPreapproval)
            .set({ status: 'cancelled', pendingAmountCents: null })
            .where(eq(localMpPreapproval.id, row.id));
          return { notify: id };
        }
        // approve: authorizes it, and the new amount that waited for the payer.
        if (row.status === 'cancelled') return { notify: null };
        await tx
          .update(localMpPreapproval)
          .set({
            status: 'authorized',
            paymentMethodLabel: FAKE_PAYMENT_METHOD_LABEL,
            nextChargeAt: new Date(clock().getTime() + MONTH_MS),
            amountCents: row.pendingAmountCents ?? row.amountCents,
            pendingAmountCents: null,
          })
          .where(eq(localMpPreapproval.id, row.id));
        return { notify: id };
      });
    },

    async decideLink(id, choice) {
      const { epoch } = await readControl(db);
      return db.transaction(async (tx) => {
        const [link] = await tx
          .select()
          .from(localMpLink)
          .where(and(eq(localMpLink.epoch, epoch), eq(localMpLink.linkId, id)));
        if (!link) return null;
        if (choice !== 'approve' && choice !== 'reject') return { paymentId: null };
        if (link.expiresAt.getTime() <= clock().getTime()) return { paymentId: null };
        const paymentId = await insertPayment(tx, epoch, {
          externalReference: link.externalReference,
          linkId: link.linkId,
          amountCents: link.amountCents,
          outcome: choice === 'approve' ? 'approved' : 'rejected',
        });
        return { paymentId };
      });
    },

    async charge(preapprovalId, outcome) {
      const { epoch } = await readControl(db);
      const [row] = await db
        .select()
        .from(localMpPreapproval)
        .where(
          and(
            eq(localMpPreapproval.epoch, epoch),
            eq(localMpPreapproval.preapprovalId, preapprovalId),
            eq(localMpPreapproval.status, 'authorized'),
          ),
        );
      if (!row) return null;
      return { paymentId: await chargePreapproval(db, epoch, row, outcome) };
    },

    async runBillingCycle(outcome) {
      const { epoch } = await readControl(db);
      const rows = await db
        .select()
        .from(localMpPreapproval)
        .where(
          and(eq(localMpPreapproval.epoch, epoch), eq(localMpPreapproval.status, 'authorized')),
        )
        .orderBy(localMpPreapproval.createdAt, localMpPreapproval.id);
      const made: string[] = [];
      for (const row of rows) made.push(await chargePreapproval(db, epoch, row, outcome));
      return made;
    },

    async reset() {
      await readControl(db);
      await db
        .update(localMpControl)
        .set({ epoch: sql`${localMpControl.epoch} + 1`, mode: 'ok' })
        .where(eq(localMpControl.id, 1));
    },
  };
}
