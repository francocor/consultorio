import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

/** What a backup directory says about itself. `manifest.json` is written last, so a partial copy has none. */
export const BackupManifest = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  database: z.object({
    name: z.string(),
    dumpFile: z.string(),
    format: z.literal('custom'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    serverVersion: z.string(),
  }),
  objects: z.object({
    bucket: z.string(),
    indexFile: z.string(),
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
});
export type BackupManifest = z.infer<typeof BackupManifest>;

export const ObjectIndexEntry = z.object({
  key: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string(),
});
export type ObjectIndexEntry = z.infer<typeof ObjectIndexEntry>;

export const MANIFEST_FILE = 'manifest.json';
export const OBJECTS_DIR = 'objects';

export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => {
        resolve(hash.digest('hex'));
      })
      .on('error', reject);
  });
}

export class BackupCorrupt extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupCorrupt';
  }
}

/** Reads and validates the manifest and the object index of a backup directory. */
export async function readBackup(
  dir: string,
): Promise<{ manifest: BackupManifest; index: ObjectIndexEntry[] }> {
  let manifest: BackupManifest;
  try {
    manifest = BackupManifest.parse(JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8')));
  } catch {
    throw new BackupCorrupt('the backup has no valid manifest (an unfinished copy?)');
  }
  const index = z
    .array(ObjectIndexEntry)
    .parse(JSON.parse(await readFile(join(dir, manifest.objects.indexFile), 'utf8')));
  return { manifest, index };
}

/**
 * Proves a backup is complete and untouched before anybody restores it: the dump and every object
 * match the checksum recorded when they were copied. Throws `BackupCorrupt` naming the first
 * problem; returns the manifest otherwise.
 */
export async function verifyBackup(dir: string): Promise<BackupManifest> {
  const { manifest, index } = await readBackup(dir);
  const dump = join(dir, manifest.database.dumpFile);
  if ((await sha256OfFile(dump)) !== manifest.database.sha256) {
    throw new BackupCorrupt('the database dump does not match its checksum');
  }
  if (index.length !== manifest.objects.count) {
    throw new BackupCorrupt('the object index does not match the manifest');
  }
  for (const entry of index) {
    const path = join(dir, OBJECTS_DIR, ...entry.key.split('/'));
    let actual: string;
    try {
      actual = await sha256OfFile(path);
    } catch {
      throw new BackupCorrupt(`an object is missing from the backup: ${entry.key}`);
    }
    if (actual !== entry.sha256) {
      throw new BackupCorrupt(`an object does not match its checksum: ${entry.key}`);
    }
  }
  return manifest;
}
