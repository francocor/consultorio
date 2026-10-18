import { describe, expect, it } from 'vitest';

import {
  inScope,
  mergeRows,
  type ChargeFact,
  type InvoicedScope,
  type PaymentFact,
} from './financial-rows.js';

const charge = (key: string, extra: Partial<ChargeFact> = {}): ChargeFact => ({
  key,
  label: null,
  chargeCount: 1,
  chargedCents: 1_000_000,
  patientCents: 700_000,
  payerCents: 300_000,
  voidedCount: 0,
  voidedCents: 0,
  outstandingCount: 0,
  outstandingCents: 0,
  ...extra,
});

const payment = (key: string, extra: Partial<PaymentFact> = {}): PaymentFact => ({
  key,
  label: null,
  paymentCount: 1,
  paymentsCents: 500_000,
  refundCount: 0,
  refundsCents: 0,
  ...extra,
});

describe('mergeRows', () => {
  it('puts what was charged, collected and invoiced of one group in one row', () => {
    const rows = mergeRows(
      [charge('a', { label: 'Centro', outstandingCents: 200_000, outstandingCount: 1 })],
      [payment('a', { paymentsCents: 800_000, refundsCents: 100_000, refundCount: 1 })],
      [
        {
          key: 'a',
          invoicedCents: 900_000,
          creditedCents: 200_000,
          netCents: 700_000,
          documents: 2,
        },
      ],
    );

    expect(rows).toEqual([
      {
        key: 'a',
        label: 'Centro',
        chargedCents: 1_000_000,
        voidedCents: 0,
        paymentsCents: 800_000,
        refundsCents: 100_000,
        collectedCents: 700_000,
        outstandingCents: 200_000,
        receivableCents: 300_000,
        invoicedNetCents: 700_000,
      },
    ]);
  });

  it('keeps a group that only has payments (money collected for a service of another period)', () => {
    const rows = mergeRows([charge('2031-05-02')], [payment('2031-05-20')], []);

    expect(rows.map((row) => [row.key, row.chargedCents, row.collectedCents])).toEqual([
      ['2031-05-02', 1_000_000, 0],
      ['2031-05-20', 0, 500_000],
    ]);
  });

  it('shows a net invoiced of zero when nothing was invoiced, and null when the dimension cannot say', () => {
    const withInvoices = mergeRows([charge('a')], [], []);
    const withoutInvoices = mergeRows([charge('Consulta')], [], null);

    expect(withInvoices[0]?.invoicedNetCents).toBe(0);
    expect(withoutInvoices[0]?.invoicedNetCents).toBeNull();
  });

  it('counts a voided charge apart and leaves it out of what was charged', () => {
    const rows = mergeRows(
      [charge('a', { chargedCents: 0, patientCents: 0, payerCents: 0, voidedCents: 2_000_000 })],
      [],
      [],
    );

    expect(rows[0]).toMatchObject({ chargedCents: 0, voidedCents: 2_000_000 });
  });

  it('orders days by date and the other groups by name, with the private patients first', () => {
    const days = mergeRows([charge('2031-05-12'), charge('2031-05-02')], [], []);
    const payers = mergeRows(
      [
        charge('osde', { label: 'OSDE' }),
        charge('private', { label: null }),
        charge('galeno', { label: 'Galeno' }),
      ],
      [],
      [],
    );

    expect(days.map((row) => row.key)).toEqual(['2031-05-02', '2031-05-12']);
    expect(payers.map((row) => row.key)).toEqual(['private', 'galeno', 'osde']);
  });
});

describe('inScope', () => {
  const row = { locationId: 'l1', professionalId: 'p1' };
  const everything: InvoicedScope = { kind: 'all' };

  it('lets the organization see every voucher', () => {
    expect(inScope(everything, row)).toBe(true);
  });

  it('lets reception see the vouchers of its locations and of its own professional profile', () => {
    expect(inScope({ kind: 'limited', locationIds: ['l1'], professionalIds: [] }, row)).toBe(true);
    expect(inScope({ kind: 'limited', locationIds: ['l2'], professionalIds: ['p1'] }, row)).toBe(
      true,
    );
  });

  it('keeps out a voucher of a location and a colleague the viewer has nothing to do with', () => {
    expect(inScope({ kind: 'limited', locationIds: ['l2'], professionalIds: ['p2'] }, row)).toBe(
      false,
    );
    expect(inScope({ kind: 'limited', locationIds: [], professionalIds: [] }, row)).toBe(false);
  });
});
