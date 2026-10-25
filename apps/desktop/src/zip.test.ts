import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractZip,
  isBackupFile,
  listFiles,
  listZipNames,
  readZipText,
  safeDestination,
  writeZip,
} from './zip.js';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-zip-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('zip files', () => {
  it('round-trips text and files, with accents in the names', async () => {
    const source = join(folder, 'source.bin');
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251));
    writeFileSync(source, bytes);
    const archive = join(folder, 'out', 'a.zip');

    await writeZip(archive, [
      { name: 'meta.json', content: '{"ñ":"á"}' },
      { name: 'files/t/Historia clínica.obj', file: source },
      { name: 'db.dump', file: source, compress: false },
    ]);

    expect((await listZipNames(archive)).sort()).toEqual([
      'db.dump',
      'files/t/Historia clínica.obj',
      'meta.json',
    ]);
    expect(await readZipText(archive, 'meta.json')).toBe('{"ñ":"á"}');
    expect(await readZipText(archive, 'missing')).toBeNull();
    const target = join(folder, 'unpacked');
    expect(await extractZip(archive, target, () => true)).toBe(3);
    expect(readFileSync(join(target, 'files', 't', 'Historia clínica.obj'))).toEqual(bytes);
    expect(readFileSync(join(target, 'db.dump'))).toEqual(bytes);
  });

  it('extracts only what is asked for', async () => {
    const archive = join(folder, 'a.zip');
    await writeZip(archive, [
      { name: 'a.txt', content: 'a' },
      { name: 'files/b.txt', content: 'b' },
    ]);

    await extractZip(archive, join(folder, 'out'), (name) => name.startsWith('files/'));

    expect(existsSync(join(folder, 'out', 'files', 'b.txt'))).toBe(true);
    expect(existsSync(join(folder, 'out', 'a.txt'))).toBe(false);
  });

  it('is complete or absent: no partial file stays after a failure', async () => {
    const archive = join(folder, 'a.zip');

    await expect(
      writeZip(archive, [{ name: 'x.bin', file: join(folder, 'does-not-exist') }]),
    ).rejects.toThrow();

    expect(existsSync(archive)).toBe(false);
    expect(existsSync(`${archive}.partial`)).toBe(false);
  });

  it('fails on a file that is not a zip', async () => {
    const notZip = join(folder, 'x.zip');
    writeFileSync(notZip, 'plain text');

    await expect(listZipNames(notZip)).rejects.toThrow();
  });
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
      'a\\b',
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
});
