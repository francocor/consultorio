import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackupCorrupt, verifyBackup, type BackupManifest } from './manifest.js';

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'backup-manifest-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A small, valid backup folder: a dump file and two objects. */
async function writeBackup(overrides: { dump?: string; objectSha?: string } = {}): Promise<void> {
  const dump = 'dump bytes';
  const objects = [
    { key: 't/aaa/docs/one', body: 'first file' },
    { key: 't/aaa/docs/two', body: 'second file' },
  ];
  await writeFile(join(dir, 'database.dump'), overrides.dump ?? dump);
  for (const object of objects) {
    const path = join(dir, 'objects', ...object.key.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, object.body);
  }
  await writeFile(
    join(dir, 'objects.json'),
    JSON.stringify(
      objects.map((object, position) => ({
        key: object.key,
        size: object.body.length,
        sha256: position === 0 && overrides.objectSha ? overrides.objectSha : sha(object.body),
        contentType: 'application/pdf',
      })),
    ),
  );
  const manifest: BackupManifest = {
    version: 1,
    createdAt: '2026-10-17T12:00:00.000Z',
    database: {
      name: 'consultorio',
      dumpFile: 'database.dump',
      format: 'custom',
      sha256: sha(dump),
      bytes: dump.length,
      serverVersion: '17.11',
    },
    objects: { bucket: 'consultorio-files', indexFile: 'objects.json', count: 2, bytes: 21 },
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
}

describe('verifyBackup', () => {
  it('accepts a complete backup', async () => {
    await writeBackup();

    const manifest = await verifyBackup(dir);

    expect(manifest.objects.count).toBe(2);
  });

  it('refuses a folder with no manifest: a copy that was never finished', async () => {
    await expect(verifyBackup(dir)).rejects.toThrow(BackupCorrupt);
  });

  it('refuses a dump that changed after it was taken', async () => {
    await writeBackup({ dump: 'tampered dump' });

    await expect(verifyBackup(dir)).rejects.toThrow(/dump does not match/);
  });

  it('refuses an object that changed, and names it', async () => {
    await writeBackup({ objectSha: sha('something else') });

    await expect(verifyBackup(dir)).rejects.toThrow(/t\/aaa\/docs\/one/);
  });

  it('refuses an object that is missing from the folder', async () => {
    await writeBackup();
    await rm(join(dir, 'objects', 't', 'aaa', 'docs', 'two'));

    await expect(verifyBackup(dir)).rejects.toThrow(/missing.*docs\/two/);
  });
});
