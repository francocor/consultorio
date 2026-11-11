import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrationCountOf, missingResources, resolveResources } from './resources.js';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-resources-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function touch(path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('what ships beside the shell', () => {
  const root = join(tmpdir(), 'Consulvia', 'resources');

  it('has one layout for the installed program and for a development run', () => {
    const resources = resolveResources(root);

    expect(resources.mainJs).toBe(join(root, 'api', 'dist', 'main.js'));
    expect(resources.pgBinDir).toBe(join(root, 'postgres', 'bin'));
    expect(resources.pgDump).toBe(join(root, 'tools', 'pg_dump.exe'));
    expect(resources.rolesSql).toBe(join(root, 'sql', '01-roles.sql'));
    expect(resources.webRoot).toBe(join(root, 'web'));
  });

  it('names what is missing', () => {
    const resources = resolveResources(folder);
    touch(resources.mainJs);

    const missing = missingResources(resources);

    expect(missing).not.toContain(resources.mainJs);
    expect(missing).toContain(resources.pgDump);
    expect(missing).toContain(resources.passwordList);
    expect(missing.length).toBeGreaterThan(5);
  });

  it('counts the migrations of the bundle', () => {
    const resources = resolveResources(folder);
    touch(
      resources.migrationsJournal,
      JSON.stringify({ entries: [{ tag: 'a' }, { tag: 'b' }, { tag: 'c' }] }),
    );

    expect(migrationCountOf(resources)).toBe(3);
  });
});
