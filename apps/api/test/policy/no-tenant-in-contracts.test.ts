import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findTenantIdentifiers } from '../support/contract-scan.js';

const CONTRACTS_SRC = fileURLToPath(
  new URL('../../../../packages/contracts/src/', import.meta.url),
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('contracts never carry a tenant identifier (identity comes from the session)', () => {
  const files = sourceFiles(CONTRACTS_SRC);

  it('scans the contracts package (the guard is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('declares no tenantId / tenant_id / organizationId field in any schema', () => {
    const offenders = files.flatMap((file) =>
      findTenantIdentifiers(readFileSync(file, 'utf8')).map((hit) => `${file}: ${hit}`),
    );

    expect(offenders).toEqual([]);
  });

  describe('the scanner itself', () => {
    it.each([
      ['an object field', 'z.object({ tenantId: z.string() })'],
      ['a quoted key', "z.object({ 'tenantId': z.uuid() })"],
      ['a snake case key', 'z.object({ tenant_id: z.uuid() })'],
      ['an organization id', 'z.strictObject({ organizationId: z.uuid() })'],
      ['an interface member', 'interface Body { tenantId: string }'],
      ['an optional member', 'interface Body { tenantId?: string }'],
    ])('flags %s', (_label, source) => {
      expect(findTenantIdentifiers(source)).toHaveLength(1);
    });

    it.each([
      ['an unrelated field', 'z.object({ name: z.string() })'],
      ['prose in a comment about the tenant', '// the tenant comes from the session'],
      ['a longer word that merely contains it', 'z.object({ tenantIdentifierLabel: z.string() })'],
    ])('does not flag %s', (_label, source) => {
      expect(findTenantIdentifiers(source)).toEqual([]);
    });
  });
});
