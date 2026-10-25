import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';

import { extractZip, listZipNames } from './zip.js';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-zip-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

async function makeZip(entries: Record<string, string>): Promise<string> {
  const file = join(folder, 'a.zip');
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file));
  return file;
}

describe('zip files (the EnterpriseDB archive of the build)', () => {
  it('lists and extracts what is asked for, with accents in the names', async () => {
    const archive = await makeZip({
      'pgsql/bin/pg_dump.exe': 'dump',
      'pgsql/Ñ.txt': 'ñ',
      readme: 'r',
    });

    expect((await listZipNames(archive)).sort()).toEqual(
      ['pgsql/Ñ.txt', 'pgsql/bin/pg_dump.exe', 'readme'].sort(),
    );
    expect(
      await extractZip(archive, join(folder, 'out'), (name) => name.startsWith('pgsql/')),
    ).toBe(2);
    expect(readFileSync(join(folder, 'out', 'pgsql', 'bin', 'pg_dump.exe'), 'utf8')).toBe('dump');
    expect(existsSync(join(folder, 'out', 'readme'))).toBe(false);
  });

  it('fails on a file that is not a zip', async () => {
    const notZip = join(folder, 'x.zip');
    await pipeline(Readable.from([Buffer.from('plain text')]), createWriteStream(notZip));

    await expect(listZipNames(notZip)).rejects.toThrow();
  });
});
