/**
 * The payments gateway of the platform subscriptions (Stage 6, design section 6: "Mercado Pago
 * preapproval + webhooks"). Every adapter (the in-memory fake, the local Mercado Pago simulator and,
 * later, the real gateway) must pass the shared suite `adapters/payments-gateway.contract.ts`.
 *
 * What the subscriptions module may rely on, and what it may NOT. The port is written for a provider
 * that is NOT idempotent and whose requests can still be in flight after the caller gave up:
 *
 * - **Every identifying value is derived by the server.** `externalReference` (and, for money moves,
 *   `idempotencyKey`) come from the organization and the subscription, never from the payer. The
 *   provider stores the reference with the resource, so the resource can be found again by it.
 * - **The key is a courtesy, not a guarantee.** `honoursIdempotencyKey` says whether the provider
 *   answers a resend of the same key with the same resource. When it is `false`, a resend of a create
 *   can make a SECOND preapproval, payment link or refund. So after any write whose outcome is not
 *   known the caller (1) searches the provider by `externalReference`, (2) adopts a match only when
 *   every identifying field is equal to what it asked for (reference, payer, amount, currency),
 *   (3) parks the subscription when more than one match is plausible or none fits, and (4) sends
 *   again only after `settleWindowMs` has passed since the last attempt, because a request that was
 *   abandoned can still land at the provider during that time.
 * - **Reconcile asks the provider, never infers.** State comes from `get*` and `find*`, not from a
 *   guess about what a failed call probably did. A webhook is only a hint to ask (`verifyWebhook`
 *   returns who and what to ask about, never a status).
 * - **Write ahead.** The caller records the intent (reference, key, amount, the time of sending) in a
 *   short transaction BEFORE each call, and writes the answer in another one AFTER it. No database
 *   transaction is open while a method of this port waits: a slow provider must never hold a
 *   connection (`CONNECTION_HOLDING_JOBS`).
 * - **Every method takes an optional `AbortSignal`.** The caller aborts it when it stops waiting; an
 *   adapter passes it to its transport and gives up. An aborted write may still have been processed.
 *
 * Amounts are integers in cents of Argentine pesos; the currency is always `ARS`. No card data ever
 * crosses this port: the payer enters it on the provider's hosted page, and the port only carries
 * the provider's own label for the payment method ("Visa terminada en 4242").
 */

export type PaymentsCurrency = 'ARS';

/** Where a preapproval (the authorization to charge the payer every month) stands at the provider. */
export const PREAPPROVAL_STATUSES = ['pending', 'authorized', 'paused', 'cancelled'] as const;
export type PreapprovalStatus = (typeof PREAPPROVAL_STATUSES)[number];

/** Where a payment stands at the provider. */
export const PAYMENT_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'refunded',
  'partially_refunded',
  'charged_back',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PreapprovalRequest {
  /** Derived by the server from the organization and the subscription attempt. Unique per attempt. */
  externalReference: string;
  payerEmail: string;
  /** What the payer reads on the hosted page (the plan label). Never patient data. */
  reason: string;
  amountCents: number;
  currency: PaymentsCurrency;
  /** Where the provider sends the payer after the hosted checkout. */
  backUrl: string;
}

/** What the provider holds for a preapproval. A lookup always says all of it. */
export interface PreapprovalDescription {
  preapprovalId: string;
  externalReference: string;
  payerEmail: string;
  amountCents: number;
  currency: PaymentsCurrency;
  status: PreapprovalStatus;
  /** The hosted page where the payer authorizes. Present while the preapproval is `pending`. */
  checkoutUrl?: string;
  /** The provider's own label for the payment method, once there is one. */
  paymentMethodLabel?: string;
  /** ISO instant of the next charge, when the provider says. */
  nextChargeAt?: string;
  createdAt: string;
}

export type CreatePreapprovalResult =
  | { status: 'created'; preapproval: PreapprovalDescription }
  /** The provider refused the request for good (an amount it does not accept, a bad address). */
  | { status: 'rejected'; message: string }
  /**
   * `outcomeUnknown: false` is the adapter's CLAIM that the request provably never reached the
   * provider (a refused connection): the caller may send a new one. A timeout, a reset after the
   * request left or a 5xx is `outcomeUnknown: true`: search by reference before anything else.
   */
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

export type PreapprovalLookup =
  | { status: 'found'; preapproval: PreapprovalDescription }
  | { status: 'unknown' }
  | { status: 'retryable'; message: string };

/** Zero, one or several preapprovals carry the reference: several is ambiguity, and the caller parks. */
export type PreapprovalSearch =
  | { status: 'ok'; preapprovals: readonly PreapprovalDescription[] }
  | { status: 'retryable'; message: string };

export interface UpdatePreapprovalAmountRequest {
  preapprovalId: string;
  /** The new monthly amount. */
  amountCents: number;
  /** Same server-derived reference of the subscription, so a lookup can tell which amount applies. */
  externalReference: string;
}

export type UpdatePreapprovalAmountResult =
  | { status: 'updated'; preapproval: PreapprovalDescription }
  /**
   * The provider does not let the amount of a live authorization change (decision Q2). Nothing
   * changed: the delta is collected as a one-off payment link, with the owner told first.
   */
  | { status: 'amount_change_refused'; message: string }
  /** The provider wants the payer to authorize the new amount again, on this hosted page. */
  | { status: 'reauthorization_required'; checkoutUrl: string }
  | { status: 'rejected'; message: string }
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

export type CancelPreapprovalResult =
  /** The preapproval is cancelled at the provider (also when it already was): nothing more is charged. */
  | { status: 'cancelled'; preapproval: PreapprovalDescription }
  | { status: 'rejected'; message: string }
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

export interface PaymentLinkRequest {
  externalReference: string;
  payerEmail: string;
  /** What the payer reads on the hosted page: the statement it pays. Never patient data. */
  title: string;
  amountCents: number;
  currency: PaymentsCurrency;
  backUrl: string;
  /** ISO instant after which the link no longer takes a payment. */
  expiresAt: string;
}

export interface PaymentLinkDescription {
  linkId: string;
  externalReference: string;
  payerEmail: string;
  amountCents: number;
  currency: PaymentsCurrency;
  url: string;
  expiresAt: string;
}

export type CreatePaymentLinkResult =
  | { status: 'created'; link: PaymentLinkDescription }
  | { status: 'rejected'; message: string }
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

export type PaymentLinkSearch =
  | { status: 'ok'; links: readonly PaymentLinkDescription[] }
  | { status: 'retryable'; message: string };

export interface RefundDescription {
  refundId: string;
  amountCents: number;
  createdAt: string;
}

/** What the provider holds for a payment, refunds included. */
export interface PaymentDescription {
  paymentId: string;
  /** The reference of the preapproval charge or the payment link this payment belongs to. */
  externalReference: string;
  /** Set when the payment is a charge of a preapproval. */
  preapprovalId?: string;
  /** Set when the payment settles a payment link. */
  linkId?: string;
  amountCents: number;
  currency: PaymentsCurrency;
  status: PaymentStatus;
  /** Sum of the refunds. */
  refundedCents: number;
  refunds: readonly RefundDescription[];
  /** ISO instant of the approval, when it was approved. */
  approvedAt?: string;
  createdAt: string;
}

export type PaymentLookup =
  | { status: 'found'; payment: PaymentDescription }
  | { status: 'unknown' }
  | { status: 'retryable'; message: string };

export interface PaymentSearchQuery {
  /** Every payment of a preapproval (its monthly charges). */
  preapprovalId?: string;
  /** Every payment that carries a reference (a payment link, a retried charge). */
  externalReference?: string;
}

export type PaymentSearch =
  | { status: 'ok'; payments: readonly PaymentDescription[] }
  | { status: 'retryable'; message: string };

export interface RefundRequest {
  paymentId: string;
  /** How much to give back; never more than what is left of the payment. */
  amountCents: number;
}

export type RefundResult =
  | { status: 'refunded'; payment: PaymentDescription; refund: RefundDescription }
  /** Nothing to give back, a payment the provider does not know, or an amount above what is left. */
  | { status: 'rejected'; message: string }
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

/**
 * The topics the provider notifies about. A notice names a resource; it never carries the state of
 * that resource, so a webhook cannot set a state: the receiver asks the provider (`getPreapproval`,
 * `getPayment`) and writes what the provider answers.
 */
export const WEBHOOK_TOPICS = ['preapproval', 'payment', 'authorized_payment'] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export interface WebhookNotice {
  /** The provider's id of this delivery, the key of idempotence (`subscription_event`). */
  eventId: string;
  topic: WebhookTopic;
  /** The preapproval or the payment to ask about. */
  resourceId: string;
  /** The instant the provider signed the notice. */
  signedAt: Date;
}

export type WebhookRejection =
  /** No signature header, or one that is not in the provider's format. */
  | 'missing_signature'
  /** The signature does not match the body and the headers (forged, altered, or the wrong secret). */
  | 'bad_signature'
  /** Correctly signed, but outside the window: a captured notice replayed later (or a clock far off). */
  | 'stale'
  /** The body is not a notice of a topic this port knows. */
  | 'malformed';

export type WebhookVerification =
  { valid: true; notice: WebhookNotice } | { valid: false; reason: WebhookRejection };

export interface WebhookVerificationOptions {
  /** The instant that is "now" (the window is measured from it). Defaults to the system clock. */
  now?: Date;
  /** How far the signed time may be from `now`, either way. Defaults to five minutes. */
  toleranceMs?: number;
}

/** The headers of a request as the web framework gives them: lowercase names. */
export type WebhookHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface PaymentsGateway {
  /**
   * Whether the provider answers a resend of the same `idempotencyKey` with the same resource. The
   * real Mercado Pago does not for preapprovals: assume `false` unless an adapter proves otherwise.
   */
  readonly honoursIdempotencyKey: boolean;
  /**
   * How long after the caller gave up (a timeout, an abort) a write may still land at the provider.
   * The caller does not send the same write again before this much time has passed since its last
   * attempt, and it does not believe "nothing was created" before then.
   */
  readonly settleWindowMs: number;

  createPreapproval(
    request: PreapprovalRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CreatePreapprovalResult>;
  getPreapproval(preapprovalId: string, signal?: AbortSignal): Promise<PreapprovalLookup>;
  /** Reconcile: every preapproval that carries the reference, whoever made it. */
  findPreapprovalsByReference(
    externalReference: string,
    signal?: AbortSignal,
  ): Promise<PreapprovalSearch>;
  updatePreapprovalAmount(
    request: UpdatePreapprovalAmountRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<UpdatePreapprovalAmountResult>;

  /**
   * Stops the charges of a preapproval (the owner cancelled, or the period of a cancelled
   * subscription ended). Cancelling is its own undo-proof: asking again for a preapproval that is
   * cancelled gives the same answer, and after an unknown outcome `getPreapproval` says where it
   * stands, so a resend is safe.
   */
  cancelPreapproval(
    preapprovalId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CancelPreapprovalResult>;

  createPaymentLink(
    request: PaymentLinkRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CreatePaymentLinkResult>;
  /** Reconcile: every payment link that carries the reference. */
  findPaymentLinksByReference(
    externalReference: string,
    signal?: AbortSignal,
  ): Promise<PaymentLinkSearch>;

  getPayment(paymentId: string, signal?: AbortSignal): Promise<PaymentLookup>;
  /** Reconcile: the payments of a preapproval, or the ones that carry a reference. */
  findPayments(query: PaymentSearchQuery, signal?: AbortSignal): Promise<PaymentSearch>;
  /**
   * Gives money back. Not safe to repeat blindly: before it sends again after an unknown outcome the
   * caller reads the refunds of `getPayment` and compares them with what it recorded BEFORE the call.
   */
  refund(
    request: RefundRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<RefundResult>;

  /**
   * Checks that a notice really comes from the provider: the HMAC of its manifest (`id`, `request-id`
   * and `ts`) with the shared secret, and that the signed time is inside the window. Pure: it reads
   * nothing and changes nothing, and the receiver enqueues a reconcile for a valid notice and does
   * nothing else. `rawBody` is the body exactly as it arrived.
   */
  verifyWebhook(
    rawBody: string | Uint8Array,
    headers: WebhookHeaders,
    options?: WebhookVerificationOptions,
  ): WebhookVerification;
}
