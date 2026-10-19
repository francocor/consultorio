import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  CONSENT_AUDIT_ACTIONS,
  CONSENT_ERRORS,
  CONSENT_METHODS,
  CONSENT_REQUEST_STATUSES,
  CONSENT_SIGNER_KINDS,
  CONSENT_TEMPLATE_STATUSES,
} from './consent.js';
import { ERROR_CATALOG } from './errors.js';

describe('consent catalogues', () => {
  it('has the template and request states of the spec', () => {
    expect([...CONSENT_TEMPLATE_STATUSES]).toEqual(['draft', 'published', 'retired']);
    expect([...CONSENT_REQUEST_STATUSES]).toEqual([
      'pending',
      'signed',
      'declined',
      'expired',
      'revoked',
    ]);
  });

  it('knows how a consent is collected and who signs it', () => {
    expect([...CONSENT_METHODS]).toEqual(['in_person', 'portal']);
    expect([...CONSENT_SIGNER_KINDS]).toEqual(['patient', 'representative']);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(CONSENT_AUDIT_ACTIONS).toEqual([
      'consent.template.created',
      'consent.template.published',
      'consent.template.retired',
      'consent.requested',
      'consent.signed',
      'consent.revoked',
      'consent.read',
      'consent.expired',
    ]);
    for (const action of CONSENT_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('has an error catalog that is part of the API catalog', () => {
    for (const [code, entry] of Object.entries(CONSENT_ERRORS)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});
