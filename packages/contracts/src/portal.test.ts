import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import {
  PORTAL_AUDIT_ACTIONS,
  PORTAL_ERRORS,
  PORTAL_IDENTITY_STATUSES,
  PORTAL_LINK_RELATIONSHIPS,
  PORTAL_LINK_STATUSES,
} from './portal.js';

describe('portal catalogues', () => {
  it('has the identity and link states of the design', () => {
    expect([...PORTAL_IDENTITY_STATUSES]).toEqual(['invited', 'active', 'deactivated']);
    expect([...PORTAL_LINK_RELATIONSHIPS]).toEqual(['self', 'representative']);
    expect([...PORTAL_LINK_STATUSES]).toEqual(['active', 'suspended', 'revoked']);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(PORTAL_AUDIT_ACTIONS).toEqual([
      'portal.identity.created',
      'portal.identity.linked',
      'portal.identity.deactivated',
      'portal.signin.success',
      'portal.signin.failure',
      'portal.read',
      'portal.download',
      'portal.profile.changed',
      'portal.denied',
    ]);
    for (const action of PORTAL_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('has an error catalog that is part of the API catalog', () => {
    // Typed as a plain catalog: once the track fills it in, it has its own literal shape.
    const catalog: Readonly<Record<string, { status: number; i18nKey: string }>> = PORTAL_ERRORS;
    for (const [code, entry] of Object.entries(catalog)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});
