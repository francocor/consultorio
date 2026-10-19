import type { IssueResult } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { compareVoucher, voucherMatches, type VoucherFacts } from './voucher-match.js';

type Issued = Extract<IssueResult, { status: 'issued' }>;

const facts: VoucherFacts = {
  issuerCuit: '20123456786',
  totalCents: 2_000_000,
  issueDate: '2026-10-17',
  buyerDocument: { type: 'dni', number: '30123456' },
  associatedVoucher: null,
};

const held: Issued = {
  status: 'issued',
  number: 5,
  cae: '70000000000001',
  caeExpiresOn: '2026-10-27',
  totalCents: 2_000_000,
  issueDate: '2026-10-17',
  issuerCuit: '20123456786',
  buyerDocument: { type: 'dni', number: '30123456' },
  associatedVoucher: null,
};

/** The voucher without one of the fields a lookup may state: the authority did not say it. */
function silentAbout(
  field: 'issuerCuit' | 'buyerDocument' | 'associatedVoucher',
  base: Issued = held,
): Issued {
  return Object.fromEntries(Object.entries(base).filter(([key]) => key !== field)) as Issued;
}

describe('whether a voucher the authority holds is the one an invoice asked for (JD-S4 R2-1)', () => {
  it('matches when the total, the date, the issuer and the recipient are the same', () => {
    expect(voucherMatches(held, facts)).toBe(true);
  });

  it('does not match a voucher with another total or another date', () => {
    expect(voucherMatches({ ...held, totalCents: 2_000_001 }, facts)).toBe(false);
    expect(voucherMatches({ ...held, issueDate: '2026-10-16' }, facts)).toBe(false);
  });

  it('does not match a voucher of another issuer, or one that does not say who issued it', () => {
    expect(voucherMatches({ ...held, issuerCuit: '30712345671' }, facts)).toBe(false);
    expect(voucherMatches(silentAbout('issuerCuit'), facts)).toBe(false);
  });

  it('does not match a voucher for another recipient, or one that does not say whom it is for', () => {
    expect(
      voucherMatches({ ...held, buyerDocument: { type: 'dni', number: '30999999' } }, facts),
    ).toBe(false);
    expect(
      voucherMatches({ ...held, buyerDocument: { type: 'cuit', number: '30123456' } }, facts),
    ).toBe(false);
    expect(voucherMatches({ ...held, buyerDocument: null }, facts)).toBe(false);
    expect(voucherMatches(silentAbout('buyerDocument'), facts)).toBe(false);
  });

  it('matches two vouchers with no document of the recipient, and refuses a document where there is none', () => {
    const anonymous = { ...facts, buyerDocument: null };

    expect(voucherMatches({ ...held, buyerDocument: null }, anonymous)).toBe(true);
    expect(voucherMatches(held, anonymous)).toBe(false);
  });

  it('asks a credit note for the voucher it cancels, and a plain invoice for none', () => {
    const note = {
      ...facts,
      associatedVoucher: { type: 'FC', pointOfSale: 1, number: 3 },
    } satisfies VoucherFacts;
    const cancelling = { ...held, associatedVoucher: { type: 'FC', pointOfSale: 1, number: 3 } };

    expect(voucherMatches(cancelling, note)).toBe(true);
    expect(
      voucherMatches(
        { ...cancelling, associatedVoucher: { type: 'FC', pointOfSale: 1, number: 4 } },
        note,
      ),
    ).toBe(false);
    expect(voucherMatches(held, note)).toBe(false);
    expect(voucherMatches(silentAbout('associatedVoucher', cancelling), note)).toBe(false);
    // A plain invoice does not match a voucher that cancels something.
    expect(voucherMatches(cancelling, facts)).toBe(false);
    expect(voucherMatches({ ...held, associatedVoucher: undefined }, facts)).toBe(true);
  });
});

describe('telling a voucher that differs from one that cannot be told (JD-S4 R5-1)', () => {
  it('says "match" only when every field is stated and the same', () => {
    expect(compareVoucher(held, facts)).toBe('match');
  });

  it('says "differs" when a field the authority states is not the one of the invoice', () => {
    expect(compareVoucher({ ...held, totalCents: 1 }, facts)).toBe('differs');
    expect(compareVoucher({ ...held, issueDate: '2026-10-16' }, facts)).toBe('differs');
    expect(compareVoucher({ ...held, issuerCuit: '30712345671' }, facts)).toBe('differs');
    expect(compareVoucher({ ...held, buyerDocument: null }, facts)).toBe('differs');
    expect(
      compareVoucher(
        { ...held, associatedVoucher: { type: 'FC', pointOfSale: 1, number: 3 } },
        facts,
      ),
    ).toBe('differs');
  });

  it('says "unclear" when a field is missing and nothing stated contradicts the invoice', () => {
    expect(compareVoucher(silentAbout('buyerDocument'), facts)).toBe('unclear');
    expect(compareVoucher(silentAbout('issuerCuit'), facts)).toBe('unclear');
    const note = { ...facts, associatedVoucher: { type: 'FC', pointOfSale: 1, number: 3 } };
    expect(compareVoucher({ ...held, associatedVoucher: undefined }, note)).toBe('unclear');
    const withoutTotal = Object.fromEntries(
      Object.entries(held).filter(([key]) => key !== 'totalCents'),
    ) as Issued;
    expect(compareVoucher(withoutTotal, facts)).toBe('unclear');
  });

  it('says "differs" when one field is missing and another one contradicts the invoice', () => {
    expect(compareVoucher({ ...silentAbout('buyerDocument'), totalCents: 1 }, facts)).toBe(
      'differs',
    );
  });
});
