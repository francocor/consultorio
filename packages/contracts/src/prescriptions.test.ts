import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import {
  CancelPrescriptionRequest,
  ERX_SIMULATOR_MODES,
  IssuePrescriptionRequest,
  MAX_PRESCRIPTION_ITEMS,
  PRESCRIPTION_AUDIT_ACTIONS,
  PRESCRIPTION_ERRORS,
  PRESCRIPTION_STATUSES,
  PortalPrescriptionDto,
  RegisterManualPrescriptionRequest,
} from './prescriptions.js';

describe('prescription catalogues', () => {
  it('has the prescription states of the spec', () => {
    expect([...PRESCRIPTION_STATUSES]).toEqual([
      'draft',
      'pending_submission',
      'issued',
      'cancelled',
      'dispensed',
      'expired',
    ]);
  });

  it('has the modes the local provider can be put in', () => {
    expect([...ERX_SIMULATOR_MODES]).toEqual(['ok', 'down', 'timeout_after_issue']);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(PRESCRIPTION_AUDIT_ACTIONS).toEqual([
      'prescription.issued',
      'prescription.cancelled',
      'prescription.read',
      'prescription.downloaded',
      'prescription.failed',
      'prescription.registered_manually',
    ]);
    for (const action of PRESCRIPTION_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('has an error catalog that is part of the API catalog', () => {
    // Typed as a plain catalog: once the track fills it in, it has its own literal shape.
    const catalog: Readonly<Record<string, { status: number; i18nKey: string }>> =
      PRESCRIPTION_ERRORS;
    for (const [code, entry] of Object.entries(catalog)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});

describe('prescription request shapes (task 5.17)', () => {
  const item = {
    genericName: 'Amoxicilina',
    dose: '500 mg',
    form: 'comprimidos',
    quantity: 21,
    instructions: '1 cada 8 horas durante 7 días',
  };
  const request = {
    clientKey: '0190a000-0000-7000-8000-0000000000a1',
    patientId: '0190a000-0000-7000-8000-0000000000a2',
    items: [item],
  };

  it('accepts a prescription with its lines, and trims the text', () => {
    const parsed = IssuePrescriptionRequest.parse({
      ...request,
      items: [{ ...item, genericName: '  Amoxicilina  ' }],
    });

    expect(parsed.items[0]?.genericName).toBe('Amoxicilina');
    expect(parsed.items[0]?.quantity).toBe(21);
  });

  it('points at the missing quantity of a line', () => {
    const withoutQuantity = { ...item, quantity: undefined };

    const result = IssuePrescriptionRequest.safeParse({ ...request, items: [withoutQuantity] });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('items.0.quantity');
  });

  it('refuses no lines, more than the limit, a quantity of zero and a blank name', () => {
    expect(IssuePrescriptionRequest.safeParse({ ...request, items: [] }).success).toBe(false);
    expect(
      IssuePrescriptionRequest.safeParse({
        ...request,
        items: Array.from({ length: MAX_PRESCRIPTION_ITEMS + 1 }, () => item),
      }).success,
    ).toBe(false);
    expect(
      IssuePrescriptionRequest.safeParse({ ...request, items: [{ ...item, quantity: 0 }] }).success,
    ).toBe(false);
    expect(
      IssuePrescriptionRequest.safeParse({ ...request, items: [{ ...item, genericName: '   ' }] })
        .success,
    ).toBe(false);
  });

  it('refuses a field the contract does not know, such as a status chosen by the client', () => {
    expect(IssuePrescriptionRequest.safeParse({ ...request, status: 'issued' }).success).toBe(
      false,
    );
  });

  it('asks for a reason to cancel, and for an identifier to register one by hand', () => {
    expect(CancelPrescriptionRequest.safeParse({ reason: 'Error en la dosis' }).success).toBe(true);
    expect(CancelPrescriptionRequest.safeParse({ reason: '   ' }).success).toBe(false);
    expect(RegisterManualPrescriptionRequest.safeParse({ identifier: 'RX-123' }).success).toBe(
      true,
    );
    expect(RegisterManualPrescriptionRequest.safeParse({}).success).toBe(false);
  });

  it('keeps the portal view of a prescription free of medications', () => {
    const portal = PortalPrescriptionDto.parse({
      id: '0190a000-0000-7000-8000-0000000000a3',
      issuedAt: '2026-10-19T12:00:00.000Z',
      status: 'issued',
    });

    expect(Object.keys(portal).sort()).toEqual(['id', 'issuedAt', 'status']);
    expect(
      PortalPrescriptionDto.safeParse({ ...portal, items: [{ genericName: 'Amoxicilina' }] })
        .success,
    ).toBe(false);
  });
});
