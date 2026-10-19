import type { AfipSimulatorMode, InvoiceIssuer, InvoiceRequest } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { voucherMatches } from '../modules/invoicing/domain/voucher-match.js';

/**
 * The contract of the `InvoiceIssuer` port (design section 6, "one shared suite per port"). The
 * in-memory fake, the local AFIP simulator and, later, the WSAA/WSFEv1 adapter must all pass it:
 * what the invoicing module relies on is written here once.
 *
 * Every test works with an issuer CUIT of its own, so numbering starts at 1 for it whatever other
 * tests did to a shared store (the local simulator keeps its state in Postgres).
 */

export interface InvoiceIssuerContractTarget {
  name: string;
  /** A fresh issuer, and the way to put it in one of the simulator modes. */
  make(): Promise<{ issuer: InvoiceIssuer; setMode: (mode: AfipSimulatorMode) => Promise<void> }>;
}

const DIGIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** A CUIT with a correct check digit, different on every call. */
let sequence = 10_000_000 + (Date.now() % 80_000_000);
export function nextCuit(): string {
  for (;;) {
    sequence += 1;
    const body = `20${String(sequence).padStart(8, '0')}`;
    const sum = DIGIT_WEIGHTS.reduce(
      (total, weight, at) => total + Number(body.charAt(at)) * weight,
      0,
    );
    const check = 11 - (sum % 11);
    // A remainder that leaves 10 has no valid digit: take the next number.
    if (check !== 10) return `${body}${String(check === 11 ? 0 : check)}`;
  }
}

let keys = 0;
const key = () => `contract-${String(Date.now())}-${String((keys += 1))}`;

function requestFor(cuit: string, overrides: Partial<InvoiceRequest> = {}): InvoiceRequest {
  return {
    issuerCuit: cuit,
    pointOfSale: 1,
    type: 'FC',
    issueDate: '2026-10-17',
    currency: 'ARS',
    totalCents: 2_000_000,
    ...overrides,
  };
}

function expectIssued(result: Awaited<ReturnType<InvoiceIssuer['issue']>>) {
  if (result.status !== 'issued') {
    throw new Error(`expected an issued voucher, got ${JSON.stringify(result)}`);
  }
  return result;
}

export function describeInvoiceIssuerContract(target: InvoiceIssuerContractTarget): void {
  describe(`InvoiceIssuer contract: ${target.name}`, () => {
    it('issues the first voucher of a point of sale and type with number 1, a 14 digit CAE and a 10 day expiry', async () => {
      const { issuer } = await target.make();

      const result = expectIssued(await issuer.issue(requestFor(nextCuit()), key()));

      expect(result.number).toBe(1);
      expect(result.cae).toMatch(/^\d{14}$/);
      expect(result.caeExpiresOn).toBe('2026-10-27');
    });

    it('gives the same voucher for the same idempotency key, and the next number for a new key', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const idempotencyKey = key();

      const first = await issuer.issue(requestFor(cuit), idempotencyKey);
      const again = await issuer.issue(requestFor(cuit), idempotencyKey);
      const other = expectIssued(await issuer.issue(requestFor(cuit), key()));

      expect(again).toEqual(first);
      expect(expectIssued(first).number).toBe(1);
      expect(other.number).toBe(2);
      expect(other.cae).not.toBe(expectIssued(first).cae);
    });

    it('numbers each point of sale and each type on its own, and each issuer on its own', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const numberOf = async (request: InvoiceRequest) =>
        expectIssued(await issuer.issue(request, key())).number;

      expect(await numberOf(requestFor(cuit))).toBe(1);
      expect(await numberOf(requestFor(cuit))).toBe(2);
      expect(await numberOf(requestFor(cuit, { pointOfSale: 2 }))).toBe(1);
      expect(
        await numberOf(
          requestFor(cuit, {
            type: 'FB',
            buyerDocument: { type: 'dni', number: '30123456' },
          }),
        ),
      ).toBe(1);
      expect(await numberOf(requestFor(cuit, { type: 'NCC' }))).toBe(1);
      expect(await numberOf(requestFor(nextCuit()))).toBe(1);
      expect(await numberOf(requestFor(cuit))).toBe(3);
    });

    it('continues after the highest number the organization says it holds, when the simulator lost its memory', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();

      const first = expectIssued(
        await issuer.issue(requestFor(cuit, { lastKnownNumber: 41 }), key()),
      );
      // A hint below what the issuer already holds changes nothing: it only moves numbering forward.
      const second = expectIssued(
        await issuer.issue(requestFor(cuit, { lastKnownNumber: 7 }), key()),
      );
      const third = expectIssued(await issuer.issue(requestFor(cuit), key()));

      expect([first.number, second.number, third.number]).toEqual([42, 43, 44]);
    });

    it('answers the same voucher to a retry whose hint has moved, because the hint is not part of the request', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const idempotencyKey = key();

      const first = await issuer.issue(requestFor(cuit, { lastKnownNumber: 10 }), idempotencyKey);
      const retry = await issuer.issue(requestFor(cuit, { lastKnownNumber: 25 }), idempotencyKey);

      expect(expectIssued(first).number).toBe(11);
      expect(retry).toEqual(first);
    });

    it('rejects a buyer CUIT with a wrong check digit, with a message and no CAE', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();

      const result = await issuer.issue(
        requestFor(cuit, { buyerDocument: { type: 'cuit', number: '30712345679' } }),
        key(),
      );

      expect(result.status).toBe('rejected');
      expect(result).toMatchObject({ message: expect.stringMatching(/\S/) as string });
      expect(result).not.toHaveProperty('cae');
    });

    it('rejects a total that is not the sum of net, VAT and exempt, and a Factura A without a buyer CUIT', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();

      const mismatch = await issuer.issue(
        requestFor(cuit, {
          type: 'FB',
          netCents: 1_000_000,
          vatCents: 210_000,
          totalCents: 1_300_000,
        }),
        key(),
      );
      const noCuit = await issuer.issue(requestFor(cuit, { type: 'FA' }), key());

      expect(mismatch.status).toBe('rejected');
      expect(noCuit.status).toBe('rejected');
    });

    it('accepts a total that matches its breakdown', async () => {
      const { issuer } = await target.make();

      const result = await issuer.issue(
        requestFor(nextCuit(), {
          type: 'FB',
          netCents: 1_000_000,
          vatCents: 210_000,
          totalCents: 1_210_000,
          buyerDocument: { type: 'dni', number: '30123456' },
        }),
        key(),
      );

      expect(result.status).toBe('issued');
    });

    it('does not use a number for a rejection, and answers the same rejection to the same key', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const rejectedKey = key();
      const bad = requestFor(cuit, { buyerDocument: { type: 'cuit', number: '30712345679' } });

      const first = await issuer.issue(bad, rejectedKey);
      const again = await issuer.issue(bad, rejectedKey);
      const next = expectIssued(await issuer.issue(requestFor(cuit), key()));

      expect(first.status).toBe('rejected');
      expect(again).toEqual(first);
      expect(next.number).toBe(1);
    });

    it('answers "try again later" in an outage, issues nothing, and issues once the service is back', async () => {
      const { issuer, setMode } = await target.make();
      const cuit = nextCuit();
      const idempotencyKey = key();
      await setMode('down');

      const down = await issuer.issue(requestFor(cuit), idempotencyKey);
      await setMode('ok');
      const found = await issuer.findIssued({
        issuerCuit: cuit,
        pointOfSale: 1,
        type: 'FC',
        number: 1,
      });
      const recovered = expectIssued(await issuer.issue(requestFor(cuit), idempotencyKey));

      expect(down).toMatchObject({ status: 'retryable', outcomeUnknown: false });
      expect(found).toBeNull();
      expect(recovered.number).toBe(1);
    });

    it('after a timeout that followed the authorization, the voucher exists once and is found by number and by key', async () => {
      const { issuer, setMode } = await target.make();
      const cuit = nextCuit();
      const idempotencyKey = key();
      await setMode('timeout_after_authorize');

      const timedOut = await issuer.issue(requestFor(cuit), idempotencyKey);
      const found = await issuer.findIssued({
        issuerCuit: cuit,
        pointOfSale: 1,
        type: 'FC',
        number: 1,
      });
      const retried = await issuer.issue(requestFor(cuit), idempotencyKey);
      const next = expectIssued(await issuer.issue(requestFor(cuit), key()));

      expect(timedOut).toMatchObject({ status: 'retryable', outcomeUnknown: true });
      expect(found).toMatchObject({ status: 'issued', number: 1 });
      expect(retried).toEqual(found);
      expect(next.number).toBe(2);
    });

    it('rejects only the next request in reject_next mode, then goes back to normal', async () => {
      const { issuer, setMode } = await target.make();
      const cuit = nextCuit();
      await setMode('reject_next');

      const rejected = await issuer.issue(requestFor(cuit), key());
      const accepted = await issuer.issue(requestFor(cuit), key());

      expect(rejected.status).toBe('rejected');
      expect(accepted).toMatchObject({ status: 'issued', number: 1 });
    });

    it('still issues in slow mode', async () => {
      const { issuer, setMode } = await target.make();
      await setMode('slow');

      const result = await issuer.issue(requestFor(nextCuit()), key());

      expect(result.status).toBe('issued');
    });

    it('finds nothing for a number that was never issued, or for another issuer', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      expectIssued(await issuer.issue(requestFor(cuit), key()));

      expect(
        await issuer.findIssued({ issuerCuit: cuit, pointOfSale: 1, type: 'FC', number: 2 }),
      ).toBeNull();
      expect(
        await issuer.findIssued({ issuerCuit: nextCuit(), pointOfSale: 1, type: 'FC', number: 1 }),
      ).toBeNull();
      expect(
        await issuer.findIssued({ issuerCuit: cuit, pointOfSale: 1, type: 'FC', number: 1 }),
      ).toMatchObject({
        status: 'issued',
        number: 1,
      });
    });

    it('numbers without gaps: every number up to the last voucher is found, and the number after it is not (JD-S4 R4-1)', async () => {
      // The invoicing module relies on it: when nothing is at a number, nothing is above it either, so a
      // request that finds the number after the last one empty may be sent without issuing twice.
      const { issuer } = await target.make();
      const cuit = nextCuit();
      for (let issued = 0; issued < 3; issued += 1) {
        expectIssued(await issuer.issue(requestFor(cuit), key()));
      }
      const at = (number: number) =>
        issuer.findIssued({ issuerCuit: cuit, pointOfSale: 1, type: 'FC', number });

      expect(await at(1)).toMatchObject({ status: 'issued', number: 1 });
      expect(await at(2)).toMatchObject({ status: 'issued', number: 2 });
      expect(await at(3)).toMatchObject({ status: 'issued', number: 3 });
      expect(await at(4)).toBeNull();
      expect(await at(5)).toBeNull();
    });

    it('says what it holds for a voucher it finds: the total and the date, so a caller can compare them', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      expectIssued(
        await issuer.issue(
          requestFor(cuit, { totalCents: 3_300_000, issueDate: '2026-10-16' }),
          key(),
        ),
      );

      const found = await issuer.findIssued({
        issuerCuit: cuit,
        pointOfSale: 1,
        type: 'FC',
        number: 1,
      });

      expect(found).toMatchObject({
        status: 'issued',
        totalCents: 3_300_000,
        issueDate: '2026-10-16',
      });
    });

    it('says who issued a voucher it finds and whom it is addressed to, so two vouchers with the same total and date can be told apart (JD-S4 R2-1)', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const buyer = { type: 'dni' as const, number: '30123456' };
      expectIssued(
        await issuer.issue(requestFor(cuit, { type: 'FB', buyerDocument: buyer }), key()),
      );
      expectIssued(await issuer.issue(requestFor(cuit, { type: 'FB' }), key()));
      const lookup = (number: number) =>
        issuer.findIssued({ issuerCuit: cuit, pointOfSale: 1, type: 'FB', number });

      expect(await lookup(1)).toMatchObject({
        status: 'issued',
        issuerCuit: cuit,
        buyerDocument: buyer,
        associatedVoucher: null,
      });
      // A voucher with no buyer document says so: `null`, not an absent field.
      expect(await lookup(2)).toMatchObject({
        status: 'issued',
        issuerCuit: cuit,
        buyerDocument: null,
        associatedVoucher: null,
      });
    });

    it('says the voucher a credit note cancels when it finds the note (JD-S4 R2-1)', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const cancelled = { type: 'FC', pointOfSale: 1, number: 7 };
      expectIssued(
        await issuer.issue(requestFor(cuit, { type: 'NCC', associatedVoucher: cancelled }), key()),
      );

      const found = await issuer.findIssued({
        issuerCuit: cuit,
        pointOfSale: 1,
        type: 'NCC',
        number: 1,
      });

      expect(found).toMatchObject({ status: 'issued', associatedVoucher: cancelled });
    });

    it('keeps the series, the answers and the lookups of two organizations apart even when they name the same CUIT', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const sharedKey = key();

      const first = expectIssued(
        await issuer.issue(requestFor(cuit, { tenantRef: 'organization-a' }), sharedKey),
      );
      // The same key and the same CUIT from another organization is a request of its own.
      const second = expectIssued(
        await issuer.issue(requestFor(cuit, { tenantRef: 'organization-b' }), sharedKey),
      );
      const secondAgain = expectIssued(
        await issuer.issue(requestFor(cuit, { tenantRef: 'organization-b' }), key()),
      );
      const lookup = (tenantRef: string, number: number) =>
        issuer.findIssued({ issuerCuit: cuit, tenantRef, pointOfSale: 1, type: 'FC', number });

      expect([first.number, second.number, secondAgain.number]).toEqual([1, 1, 2]);
      expect(second.cae).not.toBe(first.cae);
      expect(await lookup('organization-a', 1)).toMatchObject({ number: 1, cae: first.cae });
      expect(await lookup('organization-a', 2)).toBeNull();
      expect(await lookup('organization-b', 2)).toMatchObject({ number: 2 });
      expect(await lookup('organization-c', 1)).toBeNull();
    });

    it('says the last number it authorized in a series: the highest issued, and 0 for an empty series (JD-S4 R5-1)', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const last = (ref: Partial<Parameters<InvoiceIssuer['lastAuthorized']>[0]> = {}) =>
        issuer.lastAuthorized({ issuerCuit: cuit, pointOfSale: 1, type: 'FC', ...ref });

      // An empty series is an answer (0), not a failure.
      expect(await last()).toEqual({ status: 'ok', number: 0 });
      expectIssued(await issuer.issue(requestFor(cuit), key()));
      expectIssued(await issuer.issue(requestFor(cuit), key()));
      expect(await last()).toEqual({ status: 'ok', number: 2 });
      // A hint moves the numbering forward and so the last number of the series.
      expectIssued(await issuer.issue(requestFor(cuit, { lastKnownNumber: 40 }), key()));
      expect(await last()).toEqual({ status: 'ok', number: 41 });
    });

    it('does not count the vouchers of another series, issuer or organization in the last number (JD-S4 R5-1)', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      expectIssued(await issuer.issue(requestFor(cuit, { tenantRef: 'organization-a' }), key()));
      expectIssued(await issuer.issue(requestFor(cuit, { tenantRef: 'organization-a' }), key()));
      expectIssued(
        await issuer.issue(
          requestFor(cuit, { pointOfSale: 2, tenantRef: 'organization-a' }),
          key(),
        ),
      );
      expectIssued(
        await issuer.issue(requestFor(cuit, { type: 'NCC', tenantRef: 'organization-a' }), key()),
      );
      expectIssued(await issuer.issue(requestFor(cuit, { tenantRef: 'organization-b' }), key()));
      const last = (ref: Partial<Parameters<InvoiceIssuer['lastAuthorized']>[0]>) =>
        issuer.lastAuthorized({ issuerCuit: cuit, pointOfSale: 1, type: 'FC', ...ref });

      expect(await last({ tenantRef: 'organization-a' })).toEqual({ status: 'ok', number: 2 });
      expect(await last({ tenantRef: 'organization-b' })).toEqual({ status: 'ok', number: 1 });
      expect(await last({ tenantRef: 'organization-a', pointOfSale: 2 })).toEqual({
        status: 'ok',
        number: 1,
      });
      expect(await last({ tenantRef: 'organization-a', type: 'NCC' })).toEqual({
        status: 'ok',
        number: 1,
      });
      expect(await last({ tenantRef: 'organization-a', type: 'NCA' })).toEqual({
        status: 'ok',
        number: 0,
      });
      expect(await last({ tenantRef: 'organization-c' })).toEqual({ status: 'ok', number: 0 });
      expect(await last({ issuerCuit: nextCuit(), tenantRef: 'organization-a' })).toEqual({
        status: 'ok',
        number: 0,
      });
    });

    it('does not answer the last number in an outage, and never answers 0 for it (JD-S4 R5-1)', async () => {
      const { issuer, setMode } = await target.make();
      const cuit = nextCuit();
      expectIssued(await issuer.issue(requestFor(cuit), key()));
      await setMode('down');

      const down = await issuer.lastAuthorized({ issuerCuit: cuit, pointOfSale: 1, type: 'FC' });
      await setMode('ok');

      expect(down).toMatchObject({ status: 'retryable', outcomeUnknown: false });
      expect(down).not.toHaveProperty('number');
    });

    it('finds a voucher that says what the request said, so the facts of a request match the voucher found (round trip, JD-S4 R5-1)', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const buyer = { type: 'dni' as const, number: '30123456' };
      const request = requestFor(cuit, {
        type: 'FB',
        totalCents: 1_210_000,
        netCents: 1_000_000,
        vatCents: 210_000,
        buyerDocument: buyer,
      });
      const credit = requestFor(cuit, {
        type: 'NCC',
        associatedVoucher: { type: 'FC', pointOfSale: 1, number: 7 },
      });
      expectIssued(await issuer.issue(request, key()));
      expectIssued(await issuer.issue(credit, key()));
      const facts = (asked: InvoiceRequest) => ({
        issuerCuit: asked.issuerCuit ?? '',
        totalCents: asked.totalCents,
        issueDate: asked.issueDate,
        buyerDocument: asked.buyerDocument ?? null,
        associatedVoucher: asked.associatedVoucher ?? null,
      });

      const found = await issuer.findIssued({
        issuerCuit: cuit,
        pointOfSale: 1,
        type: 'FB',
        number: 1,
      });
      const foundCredit = await issuer.findIssued({
        issuerCuit: cuit,
        pointOfSale: 1,
        type: 'NCC',
        number: 1,
      });

      // A voucher that does not match its own request would make a caller look past its own voucher.
      if (found?.status !== 'issued' || foundCredit?.status !== 'issued') {
        throw new Error('the vouchers were not found');
      }
      expect(voucherMatches(found, facts(request))).toBe(true);
      expect(voucherMatches(foundCredit, facts(credit))).toBe(true);
      expect(voucherMatches(found, facts(credit))).toBe(false);
    });

    it('refuses a key that is reused for a different request', async () => {
      const { issuer } = await target.make();
      const cuit = nextCuit();
      const idempotencyKey = key();
      expectIssued(await issuer.issue(requestFor(cuit), idempotencyKey));

      const other = await issuer.issue(requestFor(cuit, { totalCents: 5_000_000 }), idempotencyKey);

      expect(other.status).toBe('rejected');
    });
  });
}
