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

describe('a recipient that cannot be told is not "another voucher" (JD-S4 R6-6)', () => {
  it('says "unclear", not "differs", when only the document of the recipient is not the one of the invoice', () => {
    // The authority may normalize a document, or hold the CUIT of a person we know by DNI: a voucher that
    // fits in everything else may be the invoice's, and treating it as foreign would send a second one.
    expect(compareVoucher({ ...held, buyerDocument: null }, facts)).toBe('unclear');
    expect(
      compareVoucher({ ...held, buyerDocument: { type: 'cuit', number: '20301234567' } }, facts),
    ).toBe('unclear');
    expect(
      compareVoucher({ ...held, buyerDocument: { type: 'dni', number: '30999999' } }, facts),
    ).toBe('unclear');
  });

  it('still says "differs" when anything else is not the same, whatever the recipient says', () => {
    expect(compareVoucher({ ...held, buyerDocument: null, totalCents: 1 }, facts)).toBe('differs');
    expect(compareVoucher({ ...held, buyerDocument: null, issueDate: '2026-10-16' }, facts)).toBe(
      'differs',
    );
    expect(compareVoucher({ ...held, buyerDocument: null, issuerCuit: '30712345671' }, facts)).toBe(
      'differs',
    );
    expect(
      compareVoucher(
        {
          ...held,
          buyerDocument: null,
          associatedVoucher: { type: 'FC', pointOfSale: 1, number: 3 },
        },
        facts,
      ),
    ).toBe('differs');
  });

  it('takes the document type 99 with the number 0 (consumidor final) for a voucher with no buyer', () => {
    const anonymous = { ...facts, buyerDocument: null };
    // How the authority writes an anonymous buyer: DocTipo 99, DocNro 0.
    const noBuyer = (number: string) =>
      ({ ...held, buyerDocument: { type: '99', number } }) as unknown as Issued;

    expect(compareVoucher(noBuyer('0'), anonymous)).toBe('match');
    expect(compareVoucher(noBuyer('00000000'), anonymous)).toBe('match');
    // It is not a buyer: an invoice that names one does not match it, and cannot be told from it either.
    expect(compareVoucher(noBuyer('0'), facts)).toBe('unclear');
    // A buyer with a number is not anonymous.
    expect(compareVoucher(noBuyer('12345'), anonymous)).toBe('unclear');
  });

  it('can be told that another recipient is foreign, for the comparison with an invoice that is not the one being reconciled', () => {
    expect(
      compareVoucher({ ...held, buyerDocument: null }, facts, { otherRecipientIsForeign: true }),
    ).toBe('differs');
    // Nothing else changes: a missing field is still unclear, and a match is still a match.
    expect(
      compareVoucher(silentAbout('buyerDocument'), facts, { otherRecipientIsForeign: true }),
    ).toBe('unclear');
    expect(compareVoucher(held, facts, { otherRecipientIsForeign: true })).toBe('match');
  });
});
