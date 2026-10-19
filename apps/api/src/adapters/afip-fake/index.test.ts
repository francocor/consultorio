import { describe, expect, it } from 'vitest';

import { describeInvoiceIssuerContract, nextCuit } from '../invoice-issuer.contract.js';

import { createFakeInvoiceIssuer } from './index.js';

describeInvoiceIssuerContract({
  name: 'in-memory fake',
  make: () => {
    const issuer = createFakeInvoiceIssuer({ slowMs: 5 });
    return Promise.resolve({
      issuer,
      setMode: (mode) => {
        issuer.setMode(mode);
        return Promise.resolve();
      },
    });
  },
});

const request = (cuit: string) => ({
  issuerCuit: cuit,
  pointOfSale: 1,
  type: 'FC',
  issueDate: '2026-10-17',
  currency: 'ARS',
  totalCents: 3_500_000,
});

describe('the in-memory invoice issuer (task 4.41)', () => {
  it('marks itself as a simulator, so every screen says "simulated"', () => {
    expect(createFakeInvoiceIssuer().simulated).toBe(true);
  });

  it('gives the same CAE for the same voucher in any instance (deterministic, for the demo and golden tests)', async () => {
    const cuit = nextCuit();

    const first = await createFakeInvoiceIssuer().issue(request(cuit), 'a');
    const second = await createFakeInvoiceIssuer().issue(request(cuit), 'b');
    const other = await createFakeInvoiceIssuer().issue({ ...request(cuit), pointOfSale: 2 }, 'c');

    expect(first).toEqual(second);
    expect(other).not.toEqual(first);
  });

  it('forgets everything on reset: numbering starts again and the mode goes back to ok', async () => {
    const issuer = createFakeInvoiceIssuer();
    const cuit = nextCuit();
    await issuer.issue(request(cuit), 'a');
    issuer.setMode('down');

    issuer.reset();

    expect(issuer.mode()).toBe('ok');
    expect(issuer.vouchers()).toEqual([]);
    expect(await issuer.issue(request(cuit), 'b')).toMatchObject({ status: 'issued', number: 1 });
  });

  it('lists what it issued, oldest first', async () => {
    const issuer = createFakeInvoiceIssuer();
    const cuit = nextCuit();
    await issuer.issue(request(cuit), 'a');
    await issuer.issue({ ...request(cuit), totalCents: 100 }, 'b');

    expect(issuer.vouchers().map((voucher) => [voucher.number, voucher.totalCents])).toEqual([
      [1, 3_500_000],
      [2, 100],
    ]);
  });

  it('issues a new voucher on every call when it is told not to take the key (an authority does not)', async () => {
    const issuer = createFakeInvoiceIssuer();
    const cuit = nextCuit();
    issuer.setIdempotent(false);

    const first = await issuer.issue(request(cuit), 'same');
    const second = await issuer.issue(request(cuit), 'same');

    expect(first).toMatchObject({ status: 'issued', number: 1 });
    expect(second).toMatchObject({ status: 'issued', number: 2 });
    expect(issuer.vouchers()).toHaveLength(2);
    issuer.reset();
    expect(await issuer.issue(request(cuit), 'same')).toMatchObject({ number: 1 });
    expect(await issuer.issue(request(cuit), 'same')).toMatchObject({ number: 1 });
  });
});

describe('a request that finishes after the caller gave up (JD-S4 R6-1)', () => {
  it('answers "timed out" at once and issues the voucher only when the held request is released', async () => {
    const issuer = createFakeInvoiceIssuer();
    const cuit = nextCuit();
    issuer.holdNext();

    const timedOut = await issuer.issue({ ...request(cuit), expectedNumber: 1 }, 'a');

    expect(timedOut).toMatchObject({ status: 'retryable', outcomeUnknown: true });
    expect(issuer.vouchers()).toEqual([]);
    expect(await issuer.lastAuthorized({ issuerCuit: cuit, pointOfSale: 1, type: 'FC' })).toEqual({
      status: 'ok',
      number: 0,
    });
    // The next request is not held: only the one after `holdNext`.
    const [late] = await issuer.releaseHeld();
    expect(late).toMatchObject({ status: 'issued', number: 1 });
    expect(issuer.vouchers()).toHaveLength(1);
  });

  it('refuses a held request whose number was taken in the meantime, and issues nothing for it', async () => {
    const issuer = createFakeInvoiceIssuer();
    const cuit = nextCuit();
    issuer.holdNext();
    await issuer.issue({ ...request(cuit), expectedNumber: 1 }, 'a');
    await issuer.issue({ ...request(cuit), expectedNumber: 1 }, 'b');

    const [late] = await issuer.releaseHeld();

    expect(late).toMatchObject({ status: 'not_next' });
    expect(issuer.vouchers()).toHaveLength(1);
  });

  it('forgets the held requests when told to', async () => {
    const issuer = createFakeInvoiceIssuer();
    issuer.holdNext();
    await issuer.issue(request(nextCuit()), 'a');

    issuer.dropHeld();

    expect(await issuer.releaseHeld()).toEqual([]);
    expect(issuer.vouchers()).toEqual([]);
  });
});

describe('a fake that learns what the organization holds (JD-S4 R6-1)', () => {
  it('numbers after what it is told, every time, and keeps doing so after a reset', async () => {
    const issuer = createFakeInvoiceIssuer();
    const cuit = nextCuit();
    const asked: unknown[] = [];
    let held = 41;
    issuer.rememberFrom((series) => {
      asked.push(series);
      return Promise.resolve(held);
    });

    expect(await issuer.lastAuthorized({ issuerCuit: cuit, pointOfSale: 1, type: 'FC' })).toEqual({
      status: 'ok',
      number: 41,
    });
    // A pin below what the organization holds is refused: the number is taken.
    expect(await issuer.issue({ ...request(cuit), expectedNumber: 1 }, 'a')).toMatchObject({
      status: 'not_next',
    });
    expect(await issuer.issue({ ...request(cuit), expectedNumber: 42 }, 'b')).toMatchObject({
      status: 'issued',
      number: 42,
    });
    // A voucher registered by hand in the meantime moves the numbering: the authority counts it too.
    held = 50;
    expect(await issuer.lastAuthorized({ issuerCuit: cuit, pointOfSale: 1, type: 'FC' })).toEqual({
      status: 'ok',
      number: 50,
    });
    expect(asked.length).toBeGreaterThan(1);

    issuer.reset();
    expect(await issuer.issue(request(cuit), 'c')).toMatchObject({ status: 'issued', number: 51 });
  });
});
