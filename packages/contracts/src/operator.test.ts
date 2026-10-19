import { describe, expect, it } from 'vitest';

import { PLATFORM_AUDIT_ACTIONS, isPlatformAuditAction } from './operator.js';

describe('the platform audit actions', () => {
  it('record the verification of a matricula, and the withdrawal of it, apart from the tenant trail', () => {
    for (const action of ['operator.matricula.verified', 'operator.matricula.unverified']) {
      expect(isPlatformAuditAction(action), action).toBe(true);
      expect(PLATFORM_AUDIT_ACTIONS.filter((known) => known === action)).toHaveLength(1);
    }
  });

  it('keeps every action unique and dot separated', () => {
    expect(new Set(PLATFORM_AUDIT_ACTIONS).size).toBe(PLATFORM_AUDIT_ACTIONS.length);
    for (const action of PLATFORM_AUDIT_ACTIONS) {
      expect(action, action).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });
});
