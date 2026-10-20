import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { ERROR_CATALOG } from './errors.js';
import { isPlatformAuditAction } from './operator.js';
import {
  SIGNUP_AUDIT_ACTIONS,
  SIGNUP_ERRORS,
  SIGNUP_PLATFORM_AUDIT_ACTIONS,
  SIGNUP_PURGE_AFTER_DAYS,
  SIGNUP_TERMS_KINDS,
} from './signup.js';

describe('signup catalogues', () => {
  it('purges an unverified signup after seven days, and asks for two separate acceptances', () => {
    expect(SIGNUP_PURGE_AFTER_DAYS).toBe(7);
    expect([...SIGNUP_TERMS_KINDS]).toEqual(['terms', 'data_processing']);
  });

  it('registers the signup actions of a living organization in the tenant catalogue, once each', () => {
    expect(SIGNUP_AUDIT_ACTIONS).toEqual(['signup.created', 'signup.verified', 'terms.accepted']);
    for (const action of SIGNUP_AUDIT_ACTIONS) {
      expect(
        AUDIT_ACTIONS.filter((known) => known === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('writes the purge in the platform trail, because the organization and its trail are gone', () => {
    expect(SIGNUP_PLATFORM_AUDIT_ACTIONS).toEqual(['signup.purged']);
    for (const action of SIGNUP_PLATFORM_AUDIT_ACTIONS) {
      expect(isPlatformAuditAction(action), action).toBe(true);
      expect(AUDIT_ACTIONS as readonly string[], action).not.toContain(action);
    }
  });

  it('has an error catalog that is part of the API catalog', () => {
    const catalog: Readonly<Record<string, { status: number; i18nKey: string }>> = SIGNUP_ERRORS;
    for (const [code, entry] of Object.entries(catalog)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});
