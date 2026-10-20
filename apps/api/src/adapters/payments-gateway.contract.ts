import { describe, expect, it } from 'vitest';

import type {
  CreatePaymentLinkResult,
  CreatePreapprovalResult,
  PaymentDescription,
  PaymentLinkDescription,
  PaymentLinkRequest,
  PaymentsGateway,
  PreapprovalDescription,
  PreapprovalRequest,
} from '../modules/subscriptions/application/ports.js';

/**
 * The contract of the `PaymentsGateway` port (design section 6, "one shared suite per port"). The
 * in-memory fake, the local Mercado Pago simulator and, later, the real gateway must all pass it:
 * what the subscriptions module relies on is written here once.
 *
 * The suite is written for a provider that is NOT idempotent and whose requests can still be in
 * flight: a test about a repeated key asserts what the adapter SAYS it honours
 * (`honoursIdempotencyKey`), never more; the tests about a lost answer, an abandoned call and a
 * request that completes late prove that the provider's own state, found by the server-derived
 * reference, is how the caller recovers.
 *
 * Every test uses references and keys of its own: references are global (the server derives them
 * from the organization), so nothing is shared between tests.
 */

/** The simulator modes an adapter that can fail on demand must support. */
export type GatewayMode = 'ok' | 'down' | 'lose_answer' | 'refuse_amount_change' | 'reauthorize';

export interface PaymentsGatewayHarness {
  gateway: PaymentsGateway;
  /** The secret that signs the notices of this provider. */
  secret: string;
  /** The instant "now" is for the window of a notice. */
  now: () => Date;
  setMode: (mode: GatewayMode) => Promise<void>;
  /** What the payer does on the hosted page of a preapproval: authorizes it. */
  authorize: (preapprovalId: string) => Promise<void>;
  /** The billing cycle runs for a preapproval: the provider charges the payer, approved or not. */
  chargeCycle: (preapprovalId: string, outcome: 'approved' | 'rejected') => Promise<void>;
  /** What the payer does on the hosted page of a payment link: pays. */
  payLink: (linkId: string) => Promise<void>;
  /** A notice as the provider would send it for a body, signed at `ts`. */
  sign: (
    body: string,
    ts?: number,
  ) => Promise<{ rawBody: string; headers: Record<string, string> }>;
  /**
   * Only for a provider that can be slowed down (the fake): holds the next write until `release()`.
   * With `completeLate` a caller that gives up (aborts) does not stop the write: it lands at
   * `release()`, like a request the transport could not take back. Without it, an aborted write
   * never lands.
   */
  hold?: (options?: { completeLate?: boolean }) => { release(): void; entered: Promise<void> };
}

export interface PaymentsGatewayContractTarget {
  name: string;
  /** A fresh gateway. `idempotent: false` asks for a provider that duplicates a resent write. */
  make(options?: { idempotent?: boolean }): Promise<PaymentsGatewayHarness>;
}

let counter = 0;
const unique = (prefix: string) => `${prefix}-${String(Date.now())}-${String((counter += 1))}`;

function preapprovalRequest(overrides: Partial<PreapprovalRequest> = {}): PreapprovalRequest {
  return {
    externalReference: unique('sub|org'),
    payerEmail: 'duena@clinica.example',
    reason: 'Plan profesional - 2 profesionales',
    amountCents: 4_500_000,
    currency: 'ARS',
    backUrl: 'https://clinica.consultorio.test/subscription',
    ...overrides,
  };
}

function linkRequest(overrides: Partial<PaymentLinkRequest> = {}): PaymentLinkRequest {
  return {
    externalReference: unique('stmt|org'),
    payerEmail: 'duena@clinica.example',
    title: 'Resumen de octubre',
    amountCents: 1_200_000,
    currency: 'ARS',
    backUrl: 'https://clinica.consultorio.test/subscription',
    expiresAt: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function created(result: CreatePreapprovalResult): PreapprovalDescription {
  if (result.status !== 'created') {
    throw new Error(`expected a created preapproval, got ${JSON.stringify(result)}`);
  }
  return result.preapproval;
}

function linkCreated(result: CreatePaymentLinkResult): PaymentLinkDescription {
  if (result.status !== 'created') {
    throw new Error(`expected a created payment link, got ${JSON.stringify(result)}`);
  }
  return result.link;
}

async function preapprovalsFor(gateway: PaymentsGateway, reference: string) {
  const search = await gateway.findPreapprovalsByReference(reference);
  if (search.status !== 'ok') throw new Error(`search failed: ${JSON.stringify(search)}`);
  return search.preapprovals;
}

async function paymentsOf(gateway: PaymentsGateway, preapprovalId: string) {
  const search = await gateway.findPayments({ preapprovalId });
  if (search.status !== 'ok') throw new Error(`search failed: ${JSON.stringify(search)}`);
  return search.payments;
}

async function paymentOf(gateway: PaymentsGateway, paymentId: string): Promise<PaymentDescription> {
  const lookup = await gateway.getPayment(paymentId);
  if (lookup.status !== 'found') throw new Error(`no payment: ${JSON.stringify(lookup)}`);
  return lookup.payment;
}

export function describePaymentsGatewayContract(target: PaymentsGatewayContractTarget): void {
  describe(`PaymentsGateway contract: ${target.name}`, () => {
    describe('preapprovals', () => {
      it('creates a preapproval that waits for the payer, with a hosted page and the reference it was given', async () => {
        const { gateway } = await target.make();
        const request = preapprovalRequest();

        const preapproval = created(await gateway.createPreapproval(request, unique('key')));

        expect(preapproval).toMatchObject({
          externalReference: request.externalReference,
          payerEmail: request.payerEmail,
          amountCents: request.amountCents,
          currency: 'ARS',
          status: 'pending',
        });
        expect(preapproval.preapprovalId.length).toBeGreaterThan(3);
        expect(preapproval.checkoutUrl).toMatch(/^https?:\/\//);
      });

      it('says what it holds for an id it issued, and says it does not know one it did not', async () => {
        const { gateway } = await target.make();
        const preapproval = created(
          await gateway.createPreapproval(preapprovalRequest(), unique('key')),
        );

        const lookup = await gateway.getPreapproval(preapproval.preapprovalId);
        const unknown = await gateway.getPreapproval('NOT-A-PREAPPROVAL');

        expect(lookup).toEqual({ status: 'found', preapproval });
        expect(unknown).toEqual({ status: 'unknown' });
      });

      it('becomes authorized only when the payer authorizes it, and a lookup shows the label of the payment method', async () => {
        const { gateway, authorize } = await target.make();
        const preapproval = created(
          await gateway.createPreapproval(preapprovalRequest(), unique('key')),
        );
        expect((await gateway.getPreapproval(preapproval.preapprovalId)).status).toBe('found');

        await authorize(preapproval.preapprovalId);

        const lookup = await gateway.getPreapproval(preapproval.preapprovalId);
        expect(lookup.status === 'found' ? lookup.preapproval : null).toMatchObject({
          status: 'authorized',
        });
        const authorized = lookup.status === 'found' ? lookup.preapproval : undefined;
        expect(authorized?.paymentMethodLabel).toEqual(expect.any(String));
        expect(authorized?.paymentMethodLabel?.length).toBeGreaterThan(3);
      });

      it('finds the preapprovals of a reference, and none for a reference it never saw', async () => {
        const { gateway } = await target.make();
        const request = preapprovalRequest();
        const preapproval = created(await gateway.createPreapproval(request, unique('key')));
        created(await gateway.createPreapproval(preapprovalRequest(), unique('key')));

        const found = await preapprovalsFor(gateway, request.externalReference);
        const none = await preapprovalsFor(gateway, unique('sub|never'));

        expect(found.map((entry) => entry.preapprovalId)).toEqual([preapproval.preapprovalId]);
        expect(none.map((entry) => entry.preapprovalId)).toEqual([]);
      });

      it('refuses what it can never accept: a fraction of a cent, a zero amount, no payer address', async () => {
        const { gateway } = await target.make();

        for (const bad of [
          { amountCents: 100.5 },
          { amountCents: 0 },
          { amountCents: -100 },
          { payerEmail: 'not-an-address' },
          { externalReference: '   ' },
        ]) {
          const result = await gateway.createPreapproval(preapprovalRequest(bad), unique('key'));
          expect(result.status, JSON.stringify(bad)).toBe('rejected');
        }
      });

      it('does not assume a repeated key is honoured: an adapter that says it is gives one preapproval, any adapter gives at least one', async () => {
        const { gateway } = await target.make();
        const request = preapprovalRequest();
        const key = unique('key');

        const first = created(await gateway.createPreapproval(request, key));
        const again = await gateway.createPreapproval(request, key);

        const matches = await preapprovalsFor(gateway, request.externalReference);
        expect(matches.map((entry) => entry.preapprovalId)).toContain(first.preapprovalId);
        if (gateway.honoursIdempotencyKey) {
          expect(again).toEqual({ status: 'created', preapproval: first });
          expect(matches).toHaveLength(1);
        } else {
          // A provider that does not honour the key may have made a second one: the caller sees
          // it by searching and parks, it never trusts that "same key, same resource".
          expect(matches.length).toBeGreaterThanOrEqual(1);
          expect(again.status).toBe('created');
        }
      });

      it('shows a duplicate to the search when the provider is not idempotent, so a resend can be told from the original', async () => {
        const harness = await target.make({ idempotent: false });
        if (harness.gateway.honoursIdempotencyKey) return; // this target cannot duplicate
        const request = preapprovalRequest();
        const key = unique('key');

        const first = created(await harness.gateway.createPreapproval(request, key));
        const resent = created(await harness.gateway.createPreapproval(request, key));

        const matches = await preapprovalsFor(harness.gateway, request.externalReference);
        expect(resent.preapprovalId).not.toBe(first.preapprovalId);
        expect(matches.map((entry) => entry.preapprovalId).sort()).toEqual(
          [first.preapprovalId, resent.preapprovalId].sort(),
        );
        // Every identifying field is equal: only the id, the page and the instant tell them apart,
        // which is why the caller parks the subscription instead of picking one.
        const identifying = (entry: PreapprovalDescription | undefined) => ({
          externalReference: entry?.externalReference,
          payerEmail: entry?.payerEmail,
          amountCents: entry?.amountCents,
          currency: entry?.currency,
          status: entry?.status,
        });
        expect(identifying(matches[0])).toEqual(identifying(matches[1]));
      });
    });

    describe('changing the amount', () => {
      it('updates the amount of a preapproval it holds', async () => {
        const { gateway, authorize } = await target.make();
        const request = preapprovalRequest();
        const preapproval = created(await gateway.createPreapproval(request, unique('key')));
        await authorize(preapproval.preapprovalId);

        const result = await gateway.updatePreapprovalAmount(
          {
            preapprovalId: preapproval.preapprovalId,
            amountCents: 6_000_000,
            externalReference: request.externalReference,
          },
          unique('key'),
        );

        expect(result.status).toBe('updated');
        expect(result.status === 'updated' ? result.preapproval.amountCents : 0).toBe(6_000_000);
        const lookup = await gateway.getPreapproval(preapproval.preapprovalId);
        expect(lookup.status === 'found' ? lookup.preapproval.amountCents : 0).toBe(6_000_000);
      });

      it('can refuse to change the amount of a live authorization, and then nothing changed', async () => {
        const { gateway, authorize, setMode } = await target.make();
        const request = preapprovalRequest();
        const preapproval = created(await gateway.createPreapproval(request, unique('key')));
        await authorize(preapproval.preapprovalId);
        await setMode('refuse_amount_change');

        const result = await gateway.updatePreapprovalAmount(
          {
            preapprovalId: preapproval.preapprovalId,
            amountCents: 6_000_000,
            externalReference: request.externalReference,
          },
          unique('key'),
        );

        expect(result.status).toBe('amount_change_refused');
        const lookup = await gateway.getPreapproval(preapproval.preapprovalId);
        expect(lookup.status === 'found' ? lookup.preapproval.amountCents : 0).toBe(
          request.amountCents,
        );
      });

      it('can ask the payer to authorize the new amount again, and the amount changes only when they do', async () => {
        const { gateway, authorize, setMode } = await target.make();
        const request = preapprovalRequest();
        const preapproval = created(await gateway.createPreapproval(request, unique('key')));
        await authorize(preapproval.preapprovalId);
        await setMode('reauthorize');

        const result = await gateway.updatePreapprovalAmount(
          {
            preapprovalId: preapproval.preapprovalId,
            amountCents: 6_000_000,
            externalReference: request.externalReference,
          },
          unique('key'),
        );

        expect(result.status).toBe('reauthorization_required');
        expect(result.status === 'reauthorization_required' ? result.checkoutUrl : '').toMatch(
          /^https?:\/\//,
        );
        const lookup = await gateway.getPreapproval(preapproval.preapprovalId);
        expect(lookup.status === 'found' ? lookup.preapproval.amountCents : 0).toBe(
          request.amountCents,
        );
      });

      it('rejects a change for a preapproval it does not know, or to an amount it cannot take', async () => {
        const { gateway, authorize } = await target.make();
        const request = preapprovalRequest();
        const preapproval = created(await gateway.createPreapproval(request, unique('key')));
        await authorize(preapproval.preapprovalId);

        const unknown = await gateway.updatePreapprovalAmount(
          {
            preapprovalId: 'NOT-A-PREAPPROVAL',
            amountCents: 6_000_000,
            externalReference: request.externalReference,
          },
          unique('key'),
        );
        const fraction = await gateway.updatePreapprovalAmount(
          {
            preapprovalId: preapproval.preapprovalId,
            amountCents: 10.5,
            externalReference: request.externalReference,
          },
          unique('key'),
        );

        expect(unknown.status).toBe('rejected');
        expect(fraction.status).toBe('rejected');
      });
    });

    describe('cancelling a preapproval', () => {
      it('stops it at the provider: it shows as cancelled, and cancelling again gives the same answer', async () => {
        const { gateway, authorize } = await target.make();
        const preapproval = created(
          await gateway.createPreapproval(preapprovalRequest(), unique('key')),
        );
        await authorize(preapproval.preapprovalId);

        const first = await gateway.cancelPreapproval(preapproval.preapprovalId, unique('key'));
        const again = await gateway.cancelPreapproval(preapproval.preapprovalId, unique('key'));

        expect(first.status).toBe('cancelled');
        expect(first.status === 'cancelled' ? first.preapproval.status : '').toBe('cancelled');
        expect(again.status).toBe('cancelled');
        const lookup = await gateway.getPreapproval(preapproval.preapprovalId);
        expect(lookup.status === 'found' ? lookup.preapproval.status : '').toBe('cancelled');
      });

      it('rejects a preapproval it does not know', async () => {
        const { gateway } = await target.make();

        const result = await gateway.cancelPreapproval('NOT-A-PREAPPROVAL', unique('key'));

        expect(result.status).toBe('rejected');
      });

      it('asks to try again while it is down, and leaves the preapproval as it was', async () => {
        const { gateway, authorize, setMode } = await target.make();
        const preapproval = created(
          await gateway.createPreapproval(preapprovalRequest(), unique('key')),
        );
        await authorize(preapproval.preapprovalId);
        await setMode('down');

        const result = await gateway.cancelPreapproval(preapproval.preapprovalId, unique('key'));

        expect(result).toMatchObject({ status: 'retryable', outcomeUnknown: false });
        await setMode('ok');
        const lookup = await gateway.getPreapproval(preapproval.preapprovalId);
        expect(lookup.status === 'found' ? lookup.preapproval.status : '').toBe('authorized');
      });

      it('can lose the answer after it cancelled: the lookup shows it, so a resend is not blind', async () => {
        const { gateway, authorize, setMode } = await target.make();
        const preapproval = created(
          await gateway.createPreapproval(preapprovalRequest(), unique('key')),
        );
        await authorize(preapproval.preapprovalId);
        await setMode('lose_answer');

        const lost = await gateway.cancelPreapproval(preapproval.preapprovalId, unique('key'));

        expect(lost).toMatchObject({ status: 'retryable', outcomeUnknown: true });
        const lookup = await gateway.getPreapproval(preapproval.preapprovalId);
        expect(lookup.status === 'found' ? lookup.preapproval.status : '').toBe('cancelled');
      });
    });

    describe('charges, payment links and refunds', () => {
      it('charges an authorized preapproval for its amount and shows the payment, found by the preapproval and by id', async () => {
        const { gateway, authorize, chargeCycle } = await target.make();
        const request = preapprovalRequest();
        const preapproval = created(await gateway.createPreapproval(request, unique('key')));
        await authorize(preapproval.preapprovalId);

        await chargeCycle(preapproval.preapprovalId, 'approved');

        const payments = await paymentsOf(gateway, preapproval.preapprovalId);
        expect(payments).toHaveLength(1);
        expect(payments[0]).toMatchObject({
          preapprovalId: preapproval.preapprovalId,
          externalReference: request.externalReference,
          amountCents: request.amountCents,
          currency: 'ARS',
          status: 'approved',
          refundedCents: 0,
        });
        expect(payments[0]?.approvedAt).toEqual(expect.any(String));
        expect(await paymentOf(gateway, payments[0]?.paymentId ?? '')).toEqual(payments[0]);
      });

      it('records a charge the issuer refused as rejected, never approved', async () => {
        const { gateway, authorize, chargeCycle } = await target.make();
        const preapproval = created(
          await gateway.createPreapproval(preapprovalRequest(), unique('key')),
        );
        await authorize(preapproval.preapprovalId);

        await chargeCycle(preapproval.preapprovalId, 'rejected');

        const [payment] = await paymentsOf(gateway, preapproval.preapprovalId);
        expect(payment).toMatchObject({ status: 'rejected', refundedCents: 0 });
        expect(payment?.approvedAt).toBeUndefined();
      });

      it('says it does not know a payment it never made', async () => {
        const { gateway } = await target.make();

        expect(await gateway.getPayment('NOT-A-PAYMENT')).toEqual({ status: 'unknown' });
        expect(await gateway.findPayments({ preapprovalId: 'NOT-A-PREAPPROVAL' })).toEqual({
          status: 'ok',
          payments: [],
        });
      });

      it('creates a one-off payment link with its page, finds it by reference, and settles a payment when the payer pays', async () => {
        const { gateway, payLink } = await target.make();
        const request = linkRequest();
        const link = linkCreated(await gateway.createPaymentLink(request, unique('key')));

        expect(link).toMatchObject({
          externalReference: request.externalReference,
          amountCents: request.amountCents,
          currency: 'ARS',
          expiresAt: request.expiresAt,
        });
        expect(link.url).toMatch(/^https?:\/\//);
        const found = await gateway.findPaymentLinksByReference(request.externalReference);
        expect(found).toEqual({ status: 'ok', links: [link] });

        await payLink(link.linkId);

        const search = await gateway.findPayments({ externalReference: request.externalReference });
        expect(search.status === 'ok' ? search.payments : []).toHaveLength(1);
        expect(search.status === 'ok' ? search.payments[0] : undefined).toMatchObject({
          linkId: link.linkId,
          amountCents: request.amountCents,
          status: 'approved',
        });
      });

      it('refuses a payment link with an amount it cannot take, or that has already expired', async () => {
        const { gateway } = await target.make();

        const fraction = await gateway.createPaymentLink(
          linkRequest({ amountCents: 99.9 }),
          unique('key'),
        );
        const expired = await gateway.createPaymentLink(
          linkRequest({ expiresAt: '2001-01-01T00:00:00.000Z' }),
          unique('key'),
        );

        expect(fraction.status).toBe('rejected');
        expect(expired.status).toBe('rejected');
      });

      it('refunds part of an approved payment and then the rest, and never more than was paid', async () => {
        const { gateway, authorize, chargeCycle } = await target.make();
        const request = preapprovalRequest({ amountCents: 1_000_000 });
        const preapproval = created(await gateway.createPreapproval(request, unique('key')));
        await authorize(preapproval.preapprovalId);
        await chargeCycle(preapproval.preapprovalId, 'approved');
        const [payment] = await paymentsOf(gateway, preapproval.preapprovalId);
        const paymentId = payment?.paymentId ?? '';

        const part = await gateway.refund({ paymentId, amountCents: 300_000 }, unique('key'));
        const tooMuch = await gateway.refund({ paymentId, amountCents: 800_000 }, unique('key'));
        const rest = await gateway.refund({ paymentId, amountCents: 700_000 }, unique('key'));

        expect(part.status).toBe('refunded');
        expect(part.status === 'refunded' ? part.payment : undefined).toMatchObject({
          status: 'partially_refunded',
          refundedCents: 300_000,
        });
        expect(tooMuch.status).toBe('rejected');
        expect(rest.status).toBe('refunded');
        const after = await paymentOf(gateway, paymentId);
        expect(after).toMatchObject({ status: 'refunded', refundedCents: 1_000_000 });
        expect(after.refunds.map((entry) => entry.amountCents)).toEqual([300_000, 700_000]);
      });

      it('refuses to refund a payment it never approved, one it does not know, or a zero amount', async () => {
        const { gateway, authorize, chargeCycle } = await target.make();
        const preapproval = created(
          await gateway.createPreapproval(preapprovalRequest(), unique('key')),
        );
        await authorize(preapproval.preapprovalId);
        await chargeCycle(preapproval.preapprovalId, 'rejected');
        const [declined] = await paymentsOf(gateway, preapproval.preapprovalId);

        expect(
          (
            await gateway.refund(
              { paymentId: declined?.paymentId ?? '', amountCents: 100 },
              unique('key'),
            )
          ).status,
        ).toBe('rejected');
        expect(
          (await gateway.refund({ paymentId: 'NOT-A-PAYMENT', amountCents: 100 }, unique('key')))
            .status,
        ).toBe('rejected');
        expect(
          (
            await gateway.refund(
              { paymentId: declined?.paymentId ?? '', amountCents: 0 },
              unique('key'),
            )
          ).status,
        ).toBe('rejected');
      });

      it('does not assume a repeated refund key is honoured: it never gives back more than was paid either way', async () => {
        const { gateway, authorize, chargeCycle } = await target.make();
        const request = preapprovalRequest({ amountCents: 1_000_000 });
        const preapproval = created(await gateway.createPreapproval(request, unique('key')));
        await authorize(preapproval.preapprovalId);
        await chargeCycle(preapproval.preapprovalId, 'approved');
        const [payment] = await paymentsOf(gateway, preapproval.preapprovalId);
        const paymentId = payment?.paymentId ?? '';
        const key = unique('key');

        await gateway.refund({ paymentId, amountCents: 600_000 }, key);
        const again = await gateway.refund({ paymentId, amountCents: 600_000 }, key);

        const after = await paymentOf(gateway, paymentId);
        if (gateway.honoursIdempotencyKey) {
          expect(again.status).toBe('refunded');
          expect(after.refundedCents).toBe(600_000);
        } else {
          // The second one is a second refund; the provider still refuses what exceeds the payment.
          expect(again.status).toBe('rejected');
          expect(after.refundedCents).toBe(600_000);
        }
        expect(after.refundedCents).toBeLessThanOrEqual(1_000_000);
      });
    });

    describe('an outage, a lost answer, an abandoned call and a request that completes late', () => {
      it('asks to try again while it is down, creates nothing, and works again when it is back', async () => {
        const { gateway, setMode } = await target.make();
        const request = preapprovalRequest();
        await setMode('down');

        const create = await gateway.createPreapproval(request, unique('key'));
        const lookup = await gateway.getPreapproval('ANY-ID');
        const search = await gateway.findPreapprovalsByReference(request.externalReference);
        const payment = await gateway.getPayment('ANY-ID');
        const link = await gateway.createPaymentLink(linkRequest(), unique('key'));
        const refund = await gateway.refund(
          { paymentId: 'ANY-ID', amountCents: 100 },
          unique('key'),
        );

        expect(create).toMatchObject({ status: 'retryable', outcomeUnknown: false });
        expect(link).toMatchObject({ status: 'retryable', outcomeUnknown: false });
        expect(refund).toMatchObject({ status: 'retryable', outcomeUnknown: false });
        expect(lookup.status).toBe('retryable');
        expect(search.status).toBe('retryable');
        expect(payment.status).toBe('retryable');

        await setMode('ok');
        // Nothing was created during the outage (the adapter claimed the request never left).
        expect(await preapprovalsFor(gateway, request.externalReference)).toHaveLength(0);
        created(await gateway.createPreapproval(request, unique('key')));
        expect(await preapprovalsFor(gateway, request.externalReference)).toHaveLength(1);
      });

      it('can lose the answer after it created: the search by reference finds the one preapproval it made', async () => {
        const { gateway, setMode } = await target.make();
        const request = preapprovalRequest();
        await setMode('lose_answer');

        const lost = await gateway.createPreapproval(request, unique('key'));

        expect(lost).toMatchObject({ status: 'retryable', outcomeUnknown: true });
        const found = await preapprovalsFor(gateway, request.externalReference);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
          externalReference: request.externalReference,
          payerEmail: request.payerEmail,
          amountCents: request.amountCents,
          status: 'pending',
        });
        // The mode applied once: the next call goes through.
        created(await gateway.createPreapproval(preapprovalRequest(), unique('key')));
      });

      it('can lose the answer of a refund that was given: the payment shows it, so a resend is not blind', async () => {
        const { gateway, authorize, chargeCycle, setMode } = await target.make();
        const request = preapprovalRequest({ amountCents: 1_000_000 });
        const preapproval = created(await gateway.createPreapproval(request, unique('key')));
        await authorize(preapproval.preapprovalId);
        await chargeCycle(preapproval.preapprovalId, 'approved');
        const [payment] = await paymentsOf(gateway, preapproval.preapprovalId);
        const paymentId = payment?.paymentId ?? '';
        await setMode('lose_answer');

        const lost = await gateway.refund({ paymentId, amountCents: 400_000 }, unique('key'));

        expect(lost).toMatchObject({ status: 'retryable', outcomeUnknown: true });
        const after = await paymentOf(gateway, paymentId);
        expect(after.refunds.map((entry) => entry.amountCents)).toEqual([400_000]);
      });

      it('gives up a call whose signal was aborted before it started, and creates nothing', async () => {
        const { gateway } = await target.make();
        const request = preapprovalRequest();

        await expect(
          gateway.createPreapproval(request, unique('key'), AbortSignal.abort()),
        ).rejects.toBeDefined();

        expect(await preapprovalsFor(gateway, request.externalReference)).toHaveLength(0);
      });

      it('gives up a call that is aborted while it waits, and the request never lands', async (context) => {
        const harness = await target.make();
        if (!harness.hold) return context.skip('this target cannot hold a call (no hold())');
        const request = preapprovalRequest();
        const slow = harness.hold();
        const abort = new AbortController();

        const call = harness.gateway.createPreapproval(request, unique('key'), abort.signal);
        await slow.entered;
        abort.abort();

        await expect(call).rejects.toBeDefined();
        slow.release();
        expect(await preapprovalsFor(harness.gateway, request.externalReference)).toHaveLength(0);
      });

      it('lets a request that was abandoned complete late: nothing at first, then exactly one preapproval', async (context) => {
        const harness = await target.make();
        if (!harness.hold) return context.skip('this target cannot hold a call (no hold())');
        const { gateway } = harness;
        const request = preapprovalRequest();
        const slow = harness.hold({ completeLate: true });
        const abort = new AbortController();

        const call = gateway.createPreapproval(request, unique('key'), abort.signal);
        await slow.entered;
        abort.abort();
        await expect(call).rejects.toBeDefined();

        // The caller gave up and searched: the provider knows nothing yet, and that proves nothing.
        expect(await preapprovalsFor(gateway, request.externalReference)).toHaveLength(0);

        slow.release();
        await Promise.resolve();
        // The request landed after the caller stopped waiting.
        const found = await preapprovalsFor(gateway, request.externalReference);
        expect(found).toHaveLength(1);
        expect(found[0]?.externalReference).toBe(request.externalReference);
      });

      it('states how long an abandoned write may still land, and whether it honours a repeated key', async () => {
        const { gateway } = await target.make();

        expect(gateway.settleWindowMs).toBeGreaterThan(0);
        expect(typeof gateway.honoursIdempotencyKey).toBe('boolean');
      });

      it('never creates two preapprovals for a key sent twice while the first call is in flight, when it honours the key', async (context) => {
        const harness = await target.make({ idempotent: true });
        if (!harness.hold) return context.skip('this target cannot hold a call (no hold())');
        if (!harness.gateway.honoursIdempotencyKey) {
          return context.skip('this provider does not honour the key');
        }
        const request = preapprovalRequest();
        const key = unique('key');
        const slow = harness.hold();

        const first = harness.gateway.createPreapproval(request, key);
        await slow.entered;
        const second = harness.gateway.createPreapproval(request, key);
        slow.release();

        const [a, b] = await Promise.all([first, second]);
        expect(created(b).preapprovalId).toBe(created(a).preapprovalId);
        expect(await preapprovalsFor(harness.gateway, request.externalReference)).toHaveLength(1);
      });
    });

    describe('webhooks', () => {
      const body = JSON.stringify({
        id: 424242,
        type: 'subscription_preapproval',
        action: 'updated',
        data: { id: 'PRE-1' },
      });

      it('accepts a notice signed by the provider and says only which resource to ask about', async () => {
        const harness = await target.make();
        const request = await harness.sign(body);

        const result = harness.gateway.verifyWebhook(request.rawBody, request.headers, {
          now: harness.now(),
        });

        expect(result).toMatchObject({
          valid: true,
          notice: { eventId: '424242', topic: 'preapproval', resourceId: 'PRE-1' },
        });
      });

      it('refuses a notice that was altered, forged or sent without a signature', async () => {
        const harness = await target.make();
        const request = await harness.sign(body);
        const verify = (rawBody: string, headers: Record<string, string>) =>
          harness.gateway.verifyWebhook(rawBody, headers, { now: harness.now() });

        expect(verify(body.replace('PRE-1', 'PRE-2'), request.headers)).toEqual({
          valid: false,
          reason: 'bad_signature',
        });
        expect(verify(body, { 'x-request-id': 'r-1' })).toEqual({
          valid: false,
          reason: 'missing_signature',
        });
        expect(
          verify(body, {
            ...request.headers,
            'x-signature': `ts=${String(Date.now())},v1=${'0'.repeat(64)}`,
          }),
        ).toEqual({ valid: false, reason: 'bad_signature' });
      });

      it('refuses a signed notice that is outside the window, a captured one replayed later', async () => {
        const harness = await target.make();
        const old = await harness.sign(body, harness.now().getTime() - 60 * 60_000);
        const ahead = await harness.sign(body, harness.now().getTime() + 60 * 60_000);

        for (const request of [old, ahead]) {
          expect(
            harness.gateway.verifyWebhook(request.rawBody, request.headers, { now: harness.now() }),
          ).toEqual({ valid: false, reason: 'stale' });
        }
      });
    });
  });
}
