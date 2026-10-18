import { describe, expect, it } from 'vitest';

import {
  IDENTIFICATION_THRESHOLD_CENTS,
  checkRecipient,
  creditNoteTypeFor,
  resolveInvoiceType,
} from './invoice-type.js';

// Valid CUITs (check digit verified by the contracts validator).
const RI_CUIT = '30-71234567-1';
const PERSON_CUIT = '20-12345678-6';

describe('invoice type selection (e-invoicing-afip, "Invoice type selection")', () => {
  it.each([
    ['monotributo', 'consumidor_final', 'FC'],
    ['monotributo', 'responsable_inscripto', 'FC'],
    ['monotributo', 'monotributo', 'FC'],
    ['responsable_inscripto', 'responsable_inscripto', 'FA'],
    ['responsable_inscripto', 'consumidor_final', 'FB'],
    ['responsable_inscripto', 'monotributo', 'FB'],
    ['responsable_inscripto', 'exento', 'FB'],
    ['exento', 'consumidor_final', 'FC'],
  ] as const)('issuer %s to a recipient %s issues %s', (issuer, recipient, expected) => {
    expect(resolveInvoiceType({ issuer, recipient })).toEqual({ ok: true, value: expected });
  });

  it('accepts a requested type that matches the rules', () => {
    expect(
      resolveInvoiceType({
        issuer: 'responsable_inscripto',
        recipient: 'responsable_inscripto',
        requested: 'FA',
      }),
    ).toEqual({ ok: true, value: 'FA' });
  });

  it('refuses Factura A for a monotributista', () => {
    expect(
      resolveInvoiceType({
        issuer: 'monotributo',
        recipient: 'responsable_inscripto',
        requested: 'FA',
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'country.ar.invoice.type_forbidden' } });
  });

  it('refuses a type the rules do not give for this recipient (B to a company that needs A)', () => {
    expect(
      resolveInvoiceType({
        issuer: 'responsable_inscripto',
        recipient: 'responsable_inscripto',
        requested: 'FB',
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'country.ar.invoice.type_forbidden' } });
  });

  it('refuses a credit note type as the type of an invoice', () => {
    expect(
      resolveInvoiceType({
        issuer: 'monotributo',
        recipient: 'consumidor_final',
        requested: 'NCC',
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'country.ar.invoice.type_forbidden' } });
  });
});

describe('credit note type', () => {
  it.each([
    ['FA', 'NCA'],
    ['FB', 'NCB'],
    ['FC', 'NCC'],
  ] as const)('the credit note of %s is %s', (invoice, note) => {
    expect(creditNoteTypeFor(invoice)).toEqual({ ok: true, value: note });
  });

  it('has no credit note for a credit note', () => {
    expect(creditNoteTypeFor('NCA')).toEqual({
      ok: false,
      error: { i18nKey: 'country.ar.invoice.credit_note_of_credit_note' },
    });
  });
});

describe('recipient data per type (e-invoicing-afip, "Recipient identification")', () => {
  const small = 20_000_00;

  it('requires a CUIT for Factura A', () => {
    expect(
      checkRecipient({
        type: 'FA',
        totalCents: small,
        recipient: { taxCondition: 'responsable_inscripto' },
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'country.ar.invoice.recipient_cuit_required' } });
  });

  it('rejects a CUIT with a wrong check digit for Factura A', () => {
    expect(
      checkRecipient({
        type: 'FA',
        totalCents: small,
        recipient: {
          taxCondition: 'responsable_inscripto',
          document: { type: 'cuit', number: '30-71234567-9' },
        },
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'country.ar.tax_id.invalid' } });
  });

  it('refuses a DNI as the identification of Factura A', () => {
    expect(
      checkRecipient({
        type: 'FA',
        totalCents: small,
        recipient: {
          taxCondition: 'responsable_inscripto',
          document: { type: 'dni', number: '30123456' },
        },
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'country.ar.invoice.recipient_cuit_required' } });
  });

  it('requires the recipient of Factura A to be a responsable inscripto', () => {
    expect(
      checkRecipient({
        type: 'FA',
        totalCents: small,
        recipient: {
          taxCondition: 'consumidor_final',
          document: { type: 'cuit', number: RI_CUIT },
        },
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'country.ar.invoice.recipient_condition_invalid' } });
  });

  it('normalizes a valid Factura A recipient', () => {
    expect(
      checkRecipient({
        type: 'FA',
        totalCents: small,
        recipient: {
          taxCondition: 'responsable_inscripto',
          name: 'Clinica Sur SA',
          document: { type: 'cuit', number: RI_CUIT },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        taxCondition: 'responsable_inscripto',
        name: 'Clinica Sur SA',
        document: { type: 'cuit', number: '30712345671' },
      },
    });
  });

  it('lets a consumer be anonymous below the identification threshold (Factura C)', () => {
    expect(
      checkRecipient({
        type: 'FC',
        totalCents: IDENTIFICATION_THRESHOLD_CENTS - 1,
        recipient: { taxCondition: 'consumidor_final' },
      }),
    ).toEqual({ ok: true, value: { taxCondition: 'consumidor_final' } });
  });

  it('requires name and document from the threshold up (Factura B and C)', () => {
    for (const type of ['FB', 'FC'] as const) {
      expect(
        checkRecipient({
          type,
          totalCents: IDENTIFICATION_THRESHOLD_CENTS,
          recipient: { taxCondition: 'consumidor_final' },
        }),
      ).toEqual({
        ok: false,
        error: { i18nKey: 'country.ar.invoice.recipient_identification_required' },
      });
    }
    expect(
      checkRecipient({
        type: 'FC',
        totalCents: IDENTIFICATION_THRESHOLD_CENTS,
        recipient: { taxCondition: 'consumidor_final', name: 'Ana Perez' },
      }),
    ).toEqual({
      ok: false,
      error: { i18nKey: 'country.ar.invoice.recipient_identification_required' },
    });
  });

  it('accepts a DNI or a CUIT as identification, normalized', () => {
    expect(
      checkRecipient({
        type: 'FC',
        totalCents: IDENTIFICATION_THRESHOLD_CENTS,
        recipient: {
          taxCondition: 'consumidor_final',
          name: 'Ana Perez',
          document: { type: 'dni', number: '30.123.456' },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        taxCondition: 'consumidor_final',
        name: 'Ana Perez',
        document: { type: 'dni', number: '30123456' },
      },
    });
    const withCuit = checkRecipient({
      type: 'FB',
      totalCents: IDENTIFICATION_THRESHOLD_CENTS,
      recipient: {
        taxCondition: 'consumidor_final',
        name: 'Ana Perez',
        document: { type: 'cuit', number: PERSON_CUIT },
      },
    });
    expect(withCuit).toMatchObject({ ok: true, value: { document: { number: '20123456786' } } });
  });

  it('validates a document that is given even below the threshold', () => {
    expect(
      checkRecipient({
        type: 'FC',
        totalCents: small,
        recipient: { taxCondition: 'consumidor_final', document: { type: 'dni', number: '12AB' } },
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'country.ar.national_id.invalid' } });
  });

  it('treats a payer (obra social) as a responsable inscripto recipient with its own CUIT', () => {
    expect(
      checkRecipient({
        type: 'FA',
        totalCents: small,
        recipient: {
          taxCondition: 'responsable_inscripto',
          name: 'OSDE',
          document: { type: 'cuit', number: RI_CUIT },
        },
      }),
    ).toMatchObject({ ok: true });
  });
});
