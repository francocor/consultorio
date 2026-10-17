import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  AuditMetadata,
  FORBIDDEN_METADATA_KEYS,
  isAuditAction,
} from './audit-actions.js';

describe('audit action catalogue', () => {
  it('lists unique, dot-separated lowercase actions', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const action of AUDIT_ACTIONS) {
      expect(action, action).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it('covers the mandatory event families of the audit-log spec', () => {
    const families = new Set(AUDIT_ACTIONS.map((action) => action.split('.')[0]));

    for (const family of [
      'auth',
      'clinical',
      'patient',
      'role',
      'permission',
      'location_membership',
      'sharing',
      'assignment',
      'matricula',
      'setting',
      'export',
      'archive',
      'support',
      'access',
      'tenant',
    ]) {
      expect(families.has(family), family).toBe(true);
    }
  });

  it('recognizes catalogued actions only', () => {
    expect(isAuditAction('auth.login.success')).toBe(true);
    expect(isAuditAction('clinical.note.read')).toBe(true);
    expect(isAuditAction('made.up.action')).toBe(false);
    expect(isAuditAction('')).toBe(false);
  });

  it('has the two outcomes allow and deny', () => {
    expect([...AUDIT_OUTCOMES]).toEqual(['allow', 'deny']);
  });
});

describe('audit metadata schema', () => {
  it('accepts field names, versions, roles and counts', () => {
    const metadata = {
      changedFields: ['phone', 'email'],
      version: 3,
      fromRole: 'reception',
      toRole: 'admin',
      count: 12,
      shared: true,
    };

    const parsed = AuditMetadata.parse(metadata);

    expect(parsed).toMatchObject({ changedFields: ['phone', 'email'], version: 3 });
  });

  it.each(FORBIDDEN_METADATA_KEYS)('rejects the clinical or secret key %s', (key) => {
    expect(AuditMetadata.safeParse({ [key]: 'x' }).success).toBe(false);
    expect(AuditMetadata.safeParse({ [key.toUpperCase()]: 'x' }).success).toBe(false);
  });

  it('rejects a forbidden key even when its value is empty or nested', () => {
    expect(AuditMetadata.safeParse({ content: '' }).success).toBe(false);
    expect(AuditMetadata.safeParse({ detail: { content: 'x' } }).success).toBe(false);
  });

  it('rejects nested objects and long free text (metadata is not a place for prose)', () => {
    expect(AuditMetadata.safeParse({ detail: { a: 1 } }).success).toBe(false);
    expect(AuditMetadata.safeParse({ comment: 'x'.repeat(201) }).success).toBe(false);
    expect(AuditMetadata.safeParse({ comment: 'x'.repeat(200) }).success).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(AuditMetadata.parse({})).toEqual({});
  });

  it('rejects more than 20 keys', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${String(i)}`, 1]));

    expect(AuditMetadata.safeParse(many).success).toBe(false);
  });
});
