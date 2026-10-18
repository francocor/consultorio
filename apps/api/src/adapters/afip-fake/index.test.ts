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
});
