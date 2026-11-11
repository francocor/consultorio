import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALLOWLIST as allowlist } from './no-delete-allowlist.js';

/**
 * Tenant data is deactivated, ended or revoked, never deleted (tenancy, "No deletion"). This keeps
 * the application from deleting rows by accident: any `DELETE`, `TRUNCATE` or drizzle `.delete()`
 * against a table, in TypeScript or in a migration, has to be in `no-delete.allowlist.json` with
 * the reason. The allowlist is checked both ways: an entry that no longer matches anything fails,
 * so the list cannot rot. (The grants of the database role are checked by an integration test.)
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');

const DRIZZLE_DELETE = /\b(?:tx|db|trx|transaction)\s*\.\s*delete\s*\(\s*([A-Za-z_]\w*)/g;

export interface CodeHit {
  file: string;
  table: string;
}

/** Drizzle deletes in a source file, with the table they name. */
export function findDrizzleDeletes(source: string): string[] {
  return [...source.matchAll(DRIZZLE_DELETE)].map((match) => match[1] ?? '');
}

/** SQL that deletes or truncates, in a string or a migration. Comments are not code. */
export function findSqlDeletes(source: string): number {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return [...withoutComments.matchAll(/\b(?:delete\s+from|truncate\s+table)\b/gi)].length;
}

function filesUnder(directory: string, accept: (name: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path, accept) : accept(entry.name) ? [path] : [];
  });
}

const posix = (path: string) => relative(ROOT, path).replaceAll('\\', '/');

const typescript = filesUnder(
  SRC,
  (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
).filter((path) => !posix(path).startsWith('src/db/migrations'));
const migrations = filesUnder(join(SRC, 'db', 'migrations'), (name) => name.endsWith('.sql'));

describe('no code deletes rows outside the allowlist', () => {
  it('scans the application and the migrations (the guard is not silently empty)', () => {
    expect(typescript.length).toBeGreaterThan(100);
    expect(migrations.length).toBeGreaterThanOrEqual(18);
  });

  it('every drizzle delete in TypeScript is listed with its reason', () => {
    const found = typescript.flatMap((file) =>
      findDrizzleDeletes(readFileSync(file, 'utf8')).map((table) => ({ file: posix(file), table })),
    );
    const unlisted = found.filter(
      (hit) =>
        !allowlist.code.some((entry) => entry.file === hit.file && entry.table === hit.table),
    );

    expect(unlisted).toEqual([]);
  });

  it('no TypeScript writes DELETE or TRUNCATE as SQL', () => {
    const offenders = typescript
      .filter((file) => findSqlDeletes(readFileSync(file, 'utf8')) > 0)
      .map(posix);

    expect(offenders).toEqual([]);
  });

  it('every DELETE or TRUNCATE in a migration is listed with its reason', () => {
    const offenders = migrations
      .filter((file) => findSqlDeletes(readFileSync(file, 'utf8')) > 0)
      .map(posix)
      .filter((file) => !allowlist.sql.some((entry) => entry.file === file));

    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still matches something, and says why', () => {
    for (const entry of allowlist.code) {
      const source = readFileSync(join(ROOT, entry.file), 'utf8');
      expect(findDrizzleDeletes(source), `${entry.file} ${entry.table}`).toContain(entry.table);
      expect(entry.why.length, entry.file).toBeGreaterThan(20);
    }
    for (const entry of allowlist.sql) {
      const source = readFileSync(join(ROOT, entry.file), 'utf8');
      expect(findSqlDeletes(source), entry.file).toBeGreaterThan(0);
      expect(entry.why.length, entry.file).toBeGreaterThan(20);
    }
    for (const entry of allowlist.ephemeralTables) {
      expect(entry.why.length, entry.table).toBeGreaterThan(20);
    }
  });

  describe('the scanner itself', () => {
    it.each([
      ['a drizzle delete', 'await tx.delete(patient).where(x)', 'patient'],
      ['through db', 'db.delete(location)', 'location'],
      ['with spaces', 'await trx . delete ( session )', 'session'],
    ])('finds %s', (_name, source, table) => {
      expect(findDrizzleDeletes(source)).toEqual([table]);
    });

    it.each([
      ['a Map', 'entries.delete(key)'],
      ['a Set', 'running.delete(task)'],
      ['an http route', "typed.delete('/patients/:id', {})"],
    ])('ignores %s', (_name, source) => {
      expect(findDrizzleDeletes(source)).toEqual([]);
    });

    it.each([
      ['DELETE FROM', 'DELETE FROM patient WHERE true'],
      ['lowercase', 'tx.execute(sql`delete from session`)'],
      ['TRUNCATE TABLE', 'TRUNCATE TABLE patient'],
    ])('finds SQL: %s', (_name, source) => {
      expect(findSqlDeletes(source)).toBe(1);
    });

    it.each([
      ['REVOKE DELETE', 'REVOKE DELETE, TRUNCATE ON "patient" FROM app_rw;'],
      ['a trigger test', "IF TG_OP = 'DELETE' THEN"],
      ['a comment', '-- delete from the table is never allowed'],
      ['a block comment', '/* DELETE FROM x */ select 1'],
    ])('ignores %s', (_name, source) => {
      expect(findSqlDeletes(source)).toBe(0);
    });
  });
});
