import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isBackupFile, listFiles, safeDestination, sizeOf } from './files.js';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-files-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('where an entry may land', () => {
  it('stays under the folder', () => {
    expect(safeDestination(folder, 'files/a/b.txt')).toBe(join(folder, 'files', 'a', 'b.txt'));
  });

  it('refuses names that climb out, are absolute or have odd characters (zip slip)', () => {
    for (const name of [
      '../evil.txt',
      'files/../../evil.txt',
      '/etc/passwd',
      'C:/Windows/x',
      `a${String.fromCharCode(92)}b`,
      'a\0b',
      'C:evil',
    ]) {
      expect(safeDestination(folder, name), name).toBeNull();
    }
    expect(safeDestination(folder, 'files/..%2f..%2fx')?.startsWith(folder + sep)).toBe(true);
  });
});

describe('listing the documents', () => {
  it('walks the folder, names with forward slashes, and honours the filter', async () => {
    mkdirSync(join(folder, 'docs', 'deep'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'a.obj'), 'a');
    writeFileSync(join(folder, 'docs', 'deep', 'b.obj'), 'b');
    writeFileSync(join(folder, 'docs', 'deep', 'c.obj.tmp'), 'c');
    writeFileSync(join(folder, 'docs', 'd.obj.moving'), 'd');

    const all = await listFiles(join(folder, 'docs'), 'files/', isBackupFile);

    expect(all.map((entry) => entry.name).sort()).toEqual(['files/a.obj', 'files/deep/b.obj']);
    expect(await listFiles(join(folder, 'nowhere'))).toEqual([]);
  });

  it('measures a file, and calls a missing one empty', async () => {
    writeFileSync(join(folder, 'a'), 'abcd');

    expect(await sizeOf(join(folder, 'a'))).toBe(4);
    expect(await sizeOf(join(folder, 'missing'))).toBe(0);
  });
});
