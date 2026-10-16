import { describe, expect, it } from 'vitest';

import {
  READ_ONLY_ALLOWLIST,
  ROUTE_CATEGORIES,
  isAllowedWhenReadOnly,
  type RouteCategory,
} from './route-category.js';

describe('route categories', () => {
  it('lists the nine allowlist items plus write (enum snapshot)', () => {
    expect([...ROUTE_CATEGORIES]).toMatchInlineSnapshot(`
      [
        "read",
        "audit_write",
        "auth",
        "export",
        "subscription",
        "patient_protective",
        "rectification_addendum",
        "afip_submission",
        "webhook",
        "write",
      ]
    `);
  });

  it('allows exactly the nine allowlisted categories in a read-only tenant', () => {
    expect(READ_ONLY_ALLOWLIST).toHaveLength(9);
    for (const category of READ_ONLY_ALLOWLIST) {
      expect(isAllowedWhenReadOnly(category), category).toBe(true);
    }
  });

  it('refuses plain writes in a read-only tenant', () => {
    expect(isAllowedWhenReadOnly('write')).toBe(false);
  });

  it('refuses anything that is not a known category (fail closed)', () => {
    expect(isAllowedWhenReadOnly('anything' as RouteCategory)).toBe(false);
  });
});
