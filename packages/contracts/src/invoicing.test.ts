import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  AFIP_SIMULATOR_MODES,
  CREDENTIAL_STATES,
  DEFAULT_INVOICING_SETTINGS,
  FISCAL_ENVIRONMENTS,
  INVOICE_DELIVERY_STATES,
  INVOICE_STATUSES,
  INVOICE_TYPES,
  INVOICING_AUDIT_ACTIONS,
  INVOICING_ERRORS,
  CREDIT_NOTE_TYPES,
  INVOICE_ONLY_TYPES,
  CreateCreditNoteRequest,
  CreateInvoiceRequest,
  CreateManualInvoiceRequest,
  CreatePointOfSaleRequest,
  FiscalConfigResponse,
  InvoiceDto,
  invoiceKindOf,
  InvoicingSettings,
  PutCredentialRequest,
  TAX_CONDITIONS,
  UpdatePointOfSaleRequest,
  UpsertFiscalProfileRequest,
} from './invoicing.js';

describe('invoicing catalogues', () => {
  it('has the invoice statuses of the design, and no "voided" state', () => {
    expect([...INVOICE_STATUSES]).toEqual(['pending', 'issued', 'rejected', 'manual']);
    expect([...INVOICE_STATUSES]).not.toContain('voided');
  });

  it('keeps the retry sub-state of a pending invoice apart from the statuses', () => {
    expect([...INVOICE_DELIVERY_STATES]).toEqual([
      'queued',
      'retrying',
      'awaiting_reconciliation',
      'needs_attention',
    ]);
    for (const state of INVOICE_DELIVERY_STATES) expect(INVOICE_STATUSES).not.toContain(state);
  });

  it('has the voucher types the port speaks: invoices and credit notes of A, B and C', () => {
    expect([...INVOICE_TYPES]).toEqual(['FA', 'FB', 'FC', 'NCA', 'NCB', 'NCC']);
  });

  it('has the tax conditions, environments, credential states and simulator modes of the spec', () => {
    expect([...TAX_CONDITIONS]).toEqual(['monotributo', 'responsable_inscripto', 'exento']);
    expect([...FISCAL_ENVIRONMENTS]).toEqual(['homologation', 'production']);
    expect([...CREDENTIAL_STATES]).toEqual(['valid', 'expiring', 'expired', 'invalid']);
    expect([...AFIP_SIMULATOR_MODES]).toEqual([
      'ok',
      'down',
      'slow',
      'timeout_after_authorize',
      'reject_next',
    ]);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(INVOICING_AUDIT_ACTIONS).toEqual([
      'invoice.requested',
      'invoice.issued',
      'invoice.rejected',
      'invoice.retried',
      'invoice.manual',
      'invoice.credit_note',
      'invoice.attempted',
      'invoice.needs_attention',
      'invoice.voucher_orphaned',
      'invoice.voucher_adopted',
      'invoice.replaced_unresolved',
      'invoicing.config.changed',
      'invoicing.credential.changed',
    ]);
    for (const action of INVOICING_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('has the error codes of the fiscal configuration and of the invoices', () => {
    expect(Object.keys(INVOICING_ERRORS)).toEqual([
      'fiscal_profile_required',
      'invoicing_not_ready',
      'invoice_charge_voided',
      'invoice_lines_mixed',
      'invoice_line_over_invoiced',
      'invoice_payer_cuit_required',
      'invoice_point_of_sale_invalid',
      'invoice_cannot_void',
      'invoice_credit_note_exceeds',
      'invoice_credit_note_not_applicable',
      'invoice_number_taken',
      'invoice_not_rejected',
      'invoice_pdf_not_ready',
      'invoice_awaiting_reconciliation',
      'invoice_replacement_mismatch',
      'invoice_issuer_mismatch',
      'invoice_cae_taken',
      'point_of_sale_has_invoices',
    ]);
    expect(INVOICING_ERRORS.fiscal_profile_required).toEqual({
      status: 409,
      i18nKey: 'errors.fiscal_profile_required',
    });
    // Every key points at its own code, so the web catalog can be checked against the codes.
    for (const [code, entry] of Object.entries(INVOICING_ERRORS)) {
      expect(entry.i18nKey).toBe(`errors.${code}`);
    }
  });
});

describe('invoice requests (S4.10)', () => {
  const key = '0190a000-0000-7000-8000-000000000001';
  const lineId = '0190a000-0000-7000-8000-0000000000a1';
  const create = {
    idempotencyKey: key,
    lines: [{ chargeLineId: lineId }],
    recipient: { kind: 'patient' },
  };

  it('tells an invoice type from a credit note type', () => {
    expect(invoiceKindOf('FA')).toBe('invoice');
    expect(invoiceKindOf('FC')).toBe('invoice');
    expect(invoiceKindOf('NCB')).toBe('credit_note');
    expect([...INVOICE_ONLY_TYPES, ...CREDIT_NOTE_TYPES]).toEqual([...INVOICE_TYPES]);
  });

  it('accepts lines with or without an amount, and never a credit note type for an invoice', () => {
    expect(CreateInvoiceRequest.parse(create)).toEqual(create);
    expect(
      CreateInvoiceRequest.parse({
        ...create,
        lines: [{ chargeLineId: lineId, amountCents: 1200 }],
        type: 'FB',
        pointOfSale: 3,
      }).lines[0]?.amountCents,
    ).toBe(1200);
    for (const bad of [
      { ...create, type: 'NCA' },
      { ...create, lines: [] },
      { ...create, lines: [{ chargeLineId: lineId, amountCents: 0 }] },
      { ...create, lines: [{ chargeLineId: lineId, amountCents: 10.5 }] },
      { ...create, idempotencyKey: 'not-a-key' },
      { ...create, pointOfSale: 0 },
      { ...create, recipient: { kind: 'doctor' } },
      { ...create, total: 5 },
    ]) {
      expect(CreateInvoiceRequest.safeParse(bad).success).toBe(false);
    }
  });

  it('needs a reason for a credit note, and a whole positive amount if it is partial', () => {
    expect(
      CreateCreditNoteRequest.safeParse({ idempotencyKey: key, reason: 'Error' }).success,
    ).toBe(true);
    expect(CreateCreditNoteRequest.safeParse({ idempotencyKey: key }).success).toBe(false);
    expect(
      CreateCreditNoteRequest.safeParse({ idempotencyKey: key, reason: 'Error', amountCents: -1 })
        .success,
    ).toBe(false);
    expect(CreateCreditNoteRequest.safeParse({ idempotencyKey: key, reason: '  ' }).success).toBe(
      false,
    );
  });

  it('needs the 14 digits of a CAE for a manual invoice, and says the voucher a credit note cancels', () => {
    const manual = {
      idempotencyKey: key,
      type: 'FC',
      pointOfSale: 1,
      number: 77,
      cae: '70123456789012',
      issueDate: '2031-03-01',
      totalCents: 500_000,
      lines: [{ chargeLineId: lineId }],
      recipient: { kind: 'patient' },
    };

    expect(CreateManualInvoiceRequest.safeParse(manual).success).toBe(true);
    // A credit note made by hand replaces a parked one and names the voucher it cancels (JD-S4 R5-B-W2).
    expect(
      CreateManualInvoiceRequest.safeParse({
        ...manual,
        type: 'NCC',
        replacesInvoiceId: lineId,
        associatedVoucher: { type: 'FC', pointOfSale: 1, number: 3 },
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...manual, cae: '1234' },
      { ...manual, cae: '7012345678901A' },
      { ...manual, type: 'XX' },
      // The voucher a credit note cancels is an invoice, not another credit note.
      { ...manual, associatedVoucher: { type: 'NCC', pointOfSale: 1, number: 3 } },
      { ...manual, number: 0 },
      { ...manual, issueDate: '01/03/2031' },
      { ...manual, totalCents: 0 },
    ]) {
      expect(CreateManualInvoiceRequest.safeParse(bad).success).toBe(false);
    }
  });

  it('has no field for the retry progress in the invoice a screen reads', () => {
    const fields = Object.keys(InvoiceDto.shape);

    expect(fields).not.toContain('deliveryState');
    expect(fields).not.toContain('attempts');
    expect(fields).toContain('ageMinutes');
    expect(fields).toContain('outageFlag');
    // What it shows instead of the progress: who holds a pending invoice back, and whom it holds.
    expect(fields).toContain('heldBy');
    expect(fields).toContain('blocksSeries');
  });
});

describe('invoicing settings', () => {
  it('flags a pending invoice after 24 hours by default', () => {
    expect(InvoicingSettings.parse(DEFAULT_INVOICING_SETTINGS)).toEqual({
      outageThresholdHours: 24,
    });
  });

  it('bounds the threshold to whole hours between 1 and 30 days and refuses unknown keys', () => {
    expect(InvoicingSettings.safeParse({ outageThresholdHours: 1 }).success).toBe(true);
    expect(InvoicingSettings.safeParse({ outageThresholdHours: 720 }).success).toBe(true);
    expect(InvoicingSettings.safeParse({ outageThresholdHours: 0 }).success).toBe(false);
    expect(InvoicingSettings.safeParse({ outageThresholdHours: 721 }).success).toBe(false);
    expect(InvoicingSettings.safeParse({ outageThresholdHours: 1.5 }).success).toBe(false);
    expect(InvoicingSettings.safeParse({ outageThresholdHours: 24, cuit: '20' }).success).toBe(
      false,
    );
  });
});

describe('fiscal profile request', () => {
  const valid = {
    cuit: '20-12345678-6',
    taxCondition: 'monotributo',
    businessName: '  Consultorio Aillu ',
    address: 'Av. Siempre Viva 123',
    activityStartedOn: '2020-03-01',
  };

  it('accepts the fiscal identity and trims the text', () => {
    expect(UpsertFiscalProfileRequest.parse(valid)).toEqual({
      ...valid,
      businessName: 'Consultorio Aillu',
    });
  });

  it('refuses an unknown tax condition, a blank name, a malformed date and extra keys', () => {
    for (const bad of [
      { ...valid, taxCondition: 'consumidor_final' },
      { ...valid, businessName: '   ' },
      { ...valid, activityStartedOn: '01/03/2020' },
      { ...valid, enabled: true },
    ]) {
      expect(UpsertFiscalProfileRequest.safeParse(bad).success).toBe(false);
    }
  });
});

describe('point of sale requests', () => {
  it('creates a point of sale in homologation unless told otherwise', () => {
    expect(CreatePointOfSaleRequest.parse({ number: 3 })).toEqual({ number: 3 });
    expect(CreatePointOfSaleRequest.parse({ number: 3, environment: 'production' })).toEqual({
      number: 3,
      environment: 'production',
    });
  });

  it('keeps the number inside what AFIP allows', () => {
    expect(CreatePointOfSaleRequest.safeParse({ number: 0 }).success).toBe(false);
    expect(CreatePointOfSaleRequest.safeParse({ number: 100000 }).success).toBe(false);
    expect(CreatePointOfSaleRequest.safeParse({ number: 1.5 }).success).toBe(false);
  });

  it('changes the environment or the active flag, and needs at least one of them', () => {
    expect(UpdatePointOfSaleRequest.parse({ active: false })).toEqual({ active: false });
    expect(UpdatePointOfSaleRequest.parse({ environment: 'production' })).toEqual({
      environment: 'production',
    });
    expect(UpdatePointOfSaleRequest.safeParse({}).success).toBe(false);
    expect(UpdatePointOfSaleRequest.safeParse({ number: 2 }).success).toBe(false);
  });
});

describe('credential upload request', () => {
  it('carries the certificate and the key as text', () => {
    expect(PutCredentialRequest.parse({ certificate: 'c', privateKey: 'k' })).toEqual({
      certificate: 'c',
      privateKey: 'k',
    });
  });

  it('refuses a missing part and anything that is not one of the two', () => {
    expect(PutCredentialRequest.safeParse({ certificate: 'c' }).success).toBe(false);
    expect(PutCredentialRequest.safeParse({ certificate: '', privateKey: 'k' }).success).toBe(
      false,
    );
    expect(
      PutCredentialRequest.safeParse({ certificate: 'c', privateKey: 'k', passphrase: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('fiscal configuration response', () => {
  it('has no field that could hold the certificate or the key', () => {
    const shape = Object.keys(FiscalConfigResponse.shape.credential.unwrap().shape);

    expect(shape).toEqual([
      'state',
      'notBefore',
      'notAfter',
      'subjectCuit',
      'fingerprint',
      'uploadedAt',
    ]);
  });
});
