import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  ARCHIVE_PLATFORM_AUDIT_ACTIONS,
  CANCELLATION_AUDIT_ACTIONS,
  CANCELLATION_ERRORS,
  CANCELLATION_PLATFORM_AUDIT_ACTIONS,
  EXPORT_PACKAGE_KINDS,
} from './cancellation.js';
import { ERROR_CATALOG } from './errors.js';
import { isPlatformAuditAction } from './operator.js';

describe('cancellation and archive catalogues', () => {
  it('splits the export in two parts: one administrative and one clinical per professional', () => {
    expect([...EXPORT_PACKAGE_KINDS]).toEqual(['administrative', 'clinical']);
  });

  it('registers the cancellation actions of the organization in the tenant catalogue, once each', () => {
    expect(CANCELLATION_AUDIT_ACTIONS).toEqual([
      'tenant.cancelled',
      'export.cancellation.requested',
      'export.cancellation.downloaded',
    ]);
    for (const action of CANCELLATION_AUDIT_ACTIONS) {
      expect(
        AUDIT_ACTIONS.filter((known) => known === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('writes what the platform does with a cancelled organization in the platform trail only', () => {
    expect(CANCELLATION_PLATFORM_AUDIT_ACTIONS).toEqual(['tenant.cancelled']);
    expect(ARCHIVE_PLATFORM_AUDIT_ACTIONS).toEqual([
      'archive.written',
      'archive.verified',
      'archive.accessed',
      'archive.released',
      'archive.erased',
    ]);
    for (const action of [
      ...CANCELLATION_PLATFORM_AUDIT_ACTIONS,
      ...ARCHIVE_PLATFORM_AUDIT_ACTIONS,
    ]) {
      expect(isPlatformAuditAction(action), action).toBe(true);
    }
    for (const action of ARCHIVE_PLATFORM_AUDIT_ACTIONS) {
      expect(AUDIT_ACTIONS as readonly string[], action).not.toContain(action);
    }
  });

  it('has an error catalog that is part of the API catalog', () => {
    const catalog: Readonly<Record<string, { status: number; i18nKey: string }>> =
      CANCELLATION_ERRORS;
    for (const [code, entry] of Object.entries(catalog)) {
      expect(ERROR_CATALOG, code).toHaveProperty(code);
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
    }
  });
});
