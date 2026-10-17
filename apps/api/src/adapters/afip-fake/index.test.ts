import { describe, expect, it } from 'vitest';

import { createFakeInvoiceIssuer } from './index.js';

const request = {
  pointOfSale: 1,
  type: 'FC',
  issueDate: '2026-10-17',
  currency: 'ARS',
  totalCents: 3_500_000,
};

describe('fake invoice issuer (the seam placeholder, filled in by task 4.41)', () => {
  it('has no voucher to give yet: it answers "try again later", never a CAE', async () => {
    const issuer = createFakeInvoiceIssuer();

    const result = await issuer.issue(request, 'invoice-1');

    expect(result.status).toBe('retryable');
    expect(result).toMatchObject({ outcomeUnknown: false });
    expect(result).not.toHaveProperty('cae');
  });

  it('finds nothing to reconcile', async () => {
    const issuer = createFakeInvoiceIssuer();

    await expect(issuer.findIssued({ pointOfSale: 1, type: 'FC', number: 1 })).resolves.toBeNull();
  });
});
