import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCrtDll } from './crt.js';
import { dllClosure, importedDlls } from './pe-imports.js';

const onWindows = process.platform === 'win32';
let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-pe-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('reading the DLLs a program needs', () => {
  // The program running these tests is a Windows executable: a real file with real import tables.
  it.skipIf(!onWindows)('lists what a real executable imports', () => {
    const imports = importedDlls(process.execPath).map((name) => name.toLowerCase());

    expect(imports).toContain('kernel32.dll');
    expect(imports.length).toBeGreaterThan(3);
  });

  it('refuses a file that is not a Windows program', () => {
    const notExe = join(folder, 'notes.txt');
    writeFileSync(notExe, 'this is not an executable at all, just some text');

    expect(() => importedDlls(notExe)).toThrow(/not a Windows program/);
  });

  it.skipIf(!onWindows)(
    'finds the DLLs that sit beside a program and leaves the ones Windows provides',
    () => {
      // A copy of node.exe has no DLLs beside it, so everything it imports comes from Windows.
      const copy = join(folder, 'node-copy.exe');
      copyFileSync(process.execPath, copy);

      const { found, system } = dllClosure(folder, [copy]);

      expect(found).toEqual([]);
      expect(system.map((name) => name.toLowerCase())).toContain('kernel32.dll');
    },
  );
});

describe('the Visual C++ runtime', () => {
  it('is recognised by name, in any case, and only the runtime', () => {
    for (const name of [
      'VCRUNTIME140.dll',
      'vcruntime140_1.dll',
      'MSVCP140.dll',
      'msvcp140_2.dll',
    ]) {
      expect(isCrtDll(name), name).toBe(true);
    }
    for (const name of [
      'KERNEL32.dll',
      'api-ms-win-crt-runtime-l1-1-0.dll',
      'libpq.dll',
      'ucrtbase.dll',
    ]) {
      expect(isCrtDll(name), name).toBe(false);
    }
  });
});
