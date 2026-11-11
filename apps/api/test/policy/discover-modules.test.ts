import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverModules } from '../support/discover-modules.js';
import { FIXTURE_FILES } from '../support/fixtures.js';

import { EXTRA_ALLOWLIST_FILES } from './no-delete-allowlist.js';

/**
 * Some registries of the tests are found with `import.meta.glob`. Vitest keeps the transform of
 * the file that holds the glob, so a file added to the folder afterwards can stay invisible until
 * `node_modules/.vitest-cache` is removed, and a test then passes or fails for a list that is not
 * the one on disk. `discoverModules` reads the folder when it is called, so there is nothing to
 * keep stale; the registries that must stay synchronous are checked against the folder instead.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
// Inside the package, so that the modules written here resolve their imports like any other.
const scratch = join(here, '../../node_modules/.cache/discover-modules-test');
let folder: string;

beforeAll(() => {
  mkdirSync(scratch, { recursive: true });
  folder = mkdtempSync(join(scratch, 'folder-'));
  writeFileSync(join(folder, 'a.ts'), "export const exemptions = { table_a: 'because' };\n");
  writeFileSync(join(folder, 'b.ts'), "export const exemptions = { table_b: 'because' };\n");
  writeFileSync(join(folder, 'notes.md'), 'not a module\n');
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('discoverModules', () => {
  it('imports every module of the folder, by file name, and nothing else', async () => {
    const found = await discoverModules<{ exemptions: Record<string, string> }>(folder);

    expect(Object.keys(found)).toEqual(['a.ts', 'b.ts']);
    expect(found['a.ts']?.exemptions).toEqual({ table_a: 'because' });
    expect(found['b.ts']?.exemptions).toEqual({ table_b: 'because' });
  });

  it('sees a module added after the first call (nothing is remembered)', async () => {
    await discoverModules(folder);
    writeFileSync(join(folder, 'c.ts'), "export const exemptions = { table_c: 'added' };\n");

    const found = await discoverModules<{ exemptions: Record<string, string> }>(folder);

    expect(Object.keys(found)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(found['c.ts']?.exemptions).toEqual({ table_c: 'added' });
  });

  it('finds the real exemption files of the demo coverage', async () => {
    const found = await discoverModules<{ exemptions: Record<string, string> }>(
      join(here, '../integration/demo-coverage-exemptions'),
    );

    expect(Object.keys(found).length).toBeGreaterThan(0);
    for (const file of Object.values(found)) {
      expect(Object.keys(file.exemptions).length).toBeGreaterThan(0);
    }
  });
});

describe('the registries that are found with a glob', () => {
  it('know every fixture file of the folder (if this fails, remove node_modules/.vitest-cache)', async () => {
    const onDisk = Object.keys(await discoverModules(join(here, '../support/fixtures'))).sort();

    expect(onDisk.length).toBeGreaterThan(5);
    expect(FIXTURE_FILES.map((file) => file.replace('./fixtures/', ''))).toEqual(onDisk);
  });

  it('know every list of the no-delete folder (if this fails, remove node_modules/.vitest-cache)', () => {
    const onDisk = readdirSync(join(here, 'no-delete')).filter((name) => name.endsWith('.json'));

    expect(onDisk.length).toBeGreaterThanOrEqual(3);
    expect([...EXTRA_ALLOWLIST_FILES].sort()).toEqual([...onDisk].sort());
  });
});
