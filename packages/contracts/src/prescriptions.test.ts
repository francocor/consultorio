import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import {
  ERX_SIMULATOR_MODES,
  PRESCRIPTION_AUDIT_ACTIONS,
  PRESCRIPTION_ERRORS,
  PRESCRIPTION_STATUSES,
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
    for (const [code, entry] of Object.entries(PRESCRIPTION_ERRORS)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});
