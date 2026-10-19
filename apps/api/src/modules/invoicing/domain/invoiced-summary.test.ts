import { describe, expect, it } from 'vitest';

import { summarizeInvoiced, type InvoicedLine } from './invoiced-summary.js';

let counter = 0;
function line(overrides: Partial<InvoicedLine> & { cents: number }): InvoicedLine {
  counter += 1;
  const { cents, ...rest } = overrides;
  return {
    invoiceId: `inv-${String(counter)}`,
    kind: 'invoice',
    type: 'FC',
    status: 'issued',
    issueDate: '2031-05-20',
    chargeId: 'charge-1',
    chargeLineId: `line-${String(counter)}`,
    locationId: 'centro',
    professionalId: 'dr-a',
    patientId: 'p-1',
    payerId: null,
    payerName: null,
    // Credit notes carry a negative amount; the caller says it with the sign.
    netCents: cents,
    ...rest,
  };
}

describe('summing what was invoiced (reports, S4.14: invoices minus credit notes)', () => {
  it('nets an invoice of 100000 and a credit note of 20000 to 80000', () => {
    const rows = [
      line({ cents: 10_000_000, invoiceId: 'a' }),
      line({ cents: -2_000_000, kind: 'credit_note', type: 'NCC', invoiceId: 'b' }),
    ];

    expect(summarizeInvoiced(rows, 'total')).toEqual([
      {
        key: 'all',
        invoicedCents: 10_000_000,
        creditedCents: 2_000_000,
        netCents: 8_000_000,
        documents: 2,
      },
    ]);
  });

  it('counts a document once however many lines it has', () => {
    const rows = [
      line({ cents: 600, invoiceId: 'a' }),
      line({ cents: 400, invoiceId: 'a' }),
      line({ cents: 500, invoiceId: 'b' }),
    ];

    expect(summarizeInvoiced(rows, 'total')[0]).toMatchObject({ netCents: 1_500, documents: 2 });
  });

  it('groups by location, professional and payer, each line to the charge it covers', () => {
    const rows = [
      line({
        cents: 1_000,
        locationId: 'centro',
        professionalId: 'dr-a',
        payerId: 'osde',
        payerName: 'OSDE',
      }),
      line({ cents: 2_000, locationId: 'norte', professionalId: 'dr-a' }),
      line({
        cents: 4_000,
        locationId: 'norte',
        professionalId: 'dr-b',
        payerId: 'osde',
        payerName: 'OSDE',
      }),
      line({
        cents: -500,
        kind: 'credit_note',
        type: 'NCC',
        locationId: 'norte',
        professionalId: 'dr-b',
        payerId: 'osde',
        payerName: 'OSDE',
      }),
    ];

    expect(summarizeInvoiced(rows, 'location').map((e) => [e.key, e.netCents])).toEqual([
      ['centro', 1_000],
      ['norte', 5_500],
    ]);
    expect(summarizeInvoiced(rows, 'professional').map((e) => [e.key, e.netCents])).toEqual([
      ['dr-a', 3_000],
      ['dr-b', 3_500],
    ]);
    expect(summarizeInvoiced(rows, 'payer').map((e) => [e.key, e.netCents])).toEqual([
      ['osde', 4_500],
      ['private', 2_000],
    ]);
    expect(summarizeInvoiced(rows, 'payer')[0]).toMatchObject({ label: 'OSDE' });
  });

  it('groups by the type of voucher, a credit note under its own type', () => {
    const rows = [
      line({ cents: 3_000, type: 'FA' }),
      line({ cents: 2_000, type: 'FB' }),
      line({ cents: -1_000, kind: 'credit_note', type: 'NCA' }),
    ];

    expect(summarizeInvoiced(rows, 'type').map((e) => [e.key, e.netCents])).toEqual([
      ['FA', 3_000],
      ['FB', 2_000],
      ['NCA', -1_000],
    ]);
  });

  it('groups by day or by month, in order', () => {
    const rows = [
      line({ cents: 100, issueDate: '2031-05-20' }),
      line({ cents: 200, issueDate: '2031-05-21' }),
      line({ cents: 400, issueDate: '2031-06-02' }),
      line({ cents: -50, kind: 'credit_note', type: 'NCC', issueDate: '2031-06-03' }),
    ];

    expect(summarizeInvoiced(rows, 'day').map((e) => [e.key, e.netCents])).toEqual([
      ['2031-05-20', 100],
      ['2031-05-21', 200],
      ['2031-06-02', 400],
      ['2031-06-03', -50],
    ]);
    expect(summarizeInvoiced(rows, 'month').map((e) => [e.key, e.netCents])).toEqual([
      ['2031-05', 300],
      ['2031-06', 350],
    ]);
  });

  it('has nothing to say about nothing', () => {
    expect(summarizeInvoiced([], 'location')).toEqual([]);
    expect(summarizeInvoiced([], 'total')).toEqual([
      { key: 'all', invoicedCents: 0, creditedCents: 0, netCents: 0, documents: 0 },
    ]);
  });
});
