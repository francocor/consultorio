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
  InvoicingSettings,
  TAX_CONDITIONS,
} from './invoicing.js';

describe('invoicing catalogues', () => {
  it('has the invoice statuses of the design, and no "voided" state', () => {
    expect([...INVOICE_STATUSES]).toEqual(['pending', 'issued', 'rejected', 'manual']);
    expect([...INVOICE_STATUSES]).not.toContain('voided');
  });

  it('keeps the retry sub-state of a pending invoice apart from the statuses', () => {
    expect([...INVOICE_DELIVERY_STATES]).toEqual(['queued', 'retrying', 'awaiting_reconciliation']);
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
      'invoicing.config.changed',
      'invoicing.credential.changed',
    ]);
    for (const action of INVOICING_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('starts with no error codes of its own: the track adds them to its catalog', () => {
    expect(Object.keys(INVOICING_ERRORS)).toEqual([]);
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
