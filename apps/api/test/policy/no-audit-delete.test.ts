import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * No code path deletes audit rows (audit-log, "Append-only and tamper-evident"; retention is 10
 * years). The database refuses it (a trigger, and no DELETE privilege for the runtime role); this
 * policy keeps the application from even trying. The only removal the product allows, the reset of
 * a demo tenant, lives in a SECURITY DEFINER SQL function, not in TypeScript.
 */

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** The table or one of its monthly partitions (audit_event_2026_10), not a longer name. */
const TABLE = String.raw`(?:public\.)?["']?audit_event(?:_\d{4}_\d{2})?["']?(?![\w])`;

/** TypeScript that deletes from, truncates or drops the audit table, in any of the usual spellings. */
const DELETES_AUDIT = [
  /\.delete\(\s*auditEvent\b/,
  new RegExp(String.raw`delete\s+from\s+(?:only\s+)?${TABLE}`, 'i'),
  new RegExp(String.raw`truncate\s+(?:table\s+)?(?:only\s+)?${TABLE}`, 'i'),
  new RegExp(String.raw`drop\s+table\s+(?:if\s+exists\s+)?${TABLE}`, 'i'),
  new RegExp(String.raw`alter\s+table\s+(?:only\s+)?${TABLE}\s+disable\s+trigger`, 'i'),
];

export function findAuditDeletes(source: string): string[] {
  return DELETES_AUDIT.flatMap((pattern) => (pattern.test(source) ? [pattern.source] : []));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'migrations' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('no code deletes audit rows', () => {
  const files = sourceFiles(SRC);

  it('scans the application code (the guard is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some((file) => file.replaceAll('\\', '/').endsWith('platform/audit/writer.ts')),
    ).toBe(true);
  });

  it('finds no delete, truncate or trigger bypass against audit_event in the source', () => {
    const offenders = files.flatMap((file) =>
      findAuditDeletes(readFileSync(file, 'utf8')).map((hit) => `${file}: ${hit}`),
    );

    expect(offenders).toEqual([]);
  });

  describe('the scanner itself', () => {
    it.each([
      ['a drizzle delete', 'await tx.delete(auditEvent).where(x)'],
      ['a raw delete', 'tx.execute(sql`DELETE FROM audit_event WHERE true`)'],
      ['a qualified raw delete', 'delete from public.audit_event'],
      ['a truncate', 'TRUNCATE TABLE audit_event'],
      ['a drop', 'drop table if exists "audit_event"'],
      ['a trigger bypass', 'ALTER TABLE audit_event DISABLE TRIGGER audit_event_guard'],
      ['a delete from a monthly partition', 'delete from audit_event_2026_10 where true'],
    ])('flags %s', (_name, source) => {
      expect(findAuditDeletes(source)).toHaveLength(1);
    });

    it.each([
      ['a select', 'tx.select().from(auditEvent)'],
      ['an insert', 'tx.insert(auditEvent).values(row)'],
      ['a delete from another table', 'tx.delete(careAssignment)'],
      ['a delete from a table that merely starts like it', 'delete from audit_event_archive_index'],
    ])('does not flag %s', (_name, source) => {
      expect(findAuditDeletes(source)).toEqual([]);
    });
  });
});
