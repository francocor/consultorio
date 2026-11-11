import { describe, expect, it } from 'vitest';

import { StorageKeyError, assertTenantKey, tenantKey } from './object-storage.js';

const TENANT = '0190a000-0000-7000-8000-0000000000a1';
const OTHER = '0190a000-0000-7000-8000-0000000000b2';

describe('tenantKey', () => {
  it('builds the key under the tenant prefix', () => {
    expect(tenantKey(TENANT, 'docs', 'file.pdf')).toBe(`t/${TENANT}/docs/file.pdf`);
    expect(tenantKey(TENANT, 'branding/logo.png')).toBe(`t/${TENANT}/branding/logo.png`);
  });

  it.each([
    ['a parent segment', ['..', 'x']],
    ['a dot segment', ['.', 'x']],
    ['an empty segment', ['docs', '', 'x']],
    ['a leading slash', ['/docs', 'x']],
    ['a backslash', ['docs\\x']],
    ['nothing at all', []],
  ])('refuses %s', (_name, parts) => {
    expect(() => tenantKey(TENANT, ...parts)).toThrow(StorageKeyError);
  });

  it('refuses a tenant id that is not a UUID, so the prefix cannot be forged', () => {
    expect(() => tenantKey('../other', 'x')).toThrow(StorageKeyError);
    expect(() => tenantKey('', 'x')).toThrow(StorageKeyError);
  });
});

describe('assertTenantKey', () => {
  it('accepts a key under the tenant prefix', () => {
    expect(() => {
      assertTenantKey(TENANT, `t/${TENANT}/docs/a.pdf`);
    }).not.toThrow();
    expect(() => {
      assertTenantKey(TENANT, `t/${TENANT}/quarantine/0190a000-0000-7000-8000-0000000000c3`);
    }).not.toThrow();
  });

  it.each([
    ['another tenant', `t/${OTHER}/docs/a.pdf`],
    ['no prefix', 'docs/a.pdf'],
    ['the bare prefix', `t/${TENANT}/`],
    ['a prefix that merely starts the same', `t/${TENANT}x/docs/a.pdf`],
    ['an escape through a parent segment', `t/${TENANT}/docs/../../${OTHER}/a.pdf`],
    ['an escape through a dot segment', `t/${TENANT}/./a.pdf`],
    ['an empty segment', `t/${TENANT}//a.pdf`],
    ['a leading slash', `/t/${TENANT}/a.pdf`],
    ['a backslash', `t/${TENANT}/docs\\a.pdf`],
    ['a control character', `t/${TENANT}/docs/a\u0000.pdf`],
    ['a new line', `t/${TENANT}/docs/a\n.pdf`],
    ['a very long key', `t/${TENANT}/${'a'.repeat(1100)}`],
  ])('refuses %s', (_name, key) => {
    expect(() => {
      assertTenantKey(TENANT, key);
    }).toThrow(StorageKeyError);
  });

  it('never leaks the offending key in the error message', () => {
    try {
      assertTenantKey(TENANT, `t/${OTHER}/secret-name.pdf`);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-name');
      expect((error as Error).message).not.toContain(OTHER);
    }
  });
});
