import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

import yauzl from 'yauzl';

import { safeDestination } from './files.js';

/**
 * Reads zip files. The program no longer makes or reads zips (its backups are `backup-archive.ts`); this is
 * what the build uses to unpack the EnterpriseDB archive of the PostgreSQL client tools.
 */

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveOpen, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(error);
      else resolveOpen(zip);
    });
  });
}

async function eachEntry(
  path: string,
  visit: (entry: yauzl.Entry, zip: yauzl.ZipFile) => Promise<void>,
): Promise<void> {
  const zip = await openZip(path);
  await new Promise<void>((resolveAll, reject) => {
    zip.on('error', reject);
    zip.on('end', resolveAll);
    zip.on('entry', (entry: yauzl.Entry) => {
      visit(entry, zip).then(
        () => {
          zip.readEntry();
        },
        (error: unknown) => {
          zip.close();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
    zip.readEntry();
  });
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolveStream(stream);
    });
  });
}

/** The names of the entries of a zip. */
export async function listZipNames(path: string): Promise<string[]> {
  const names: string[] = [];
  await eachEntry(path, (entry) => {
    names.push(entry.fileName);
    return Promise.resolve();
  });
  return names;
}

/** Extracts the entries whose name satisfies `wanted` under `destination`. Returns how many files it wrote. */
export async function extractZip(
  path: string,
  destination: string,
  wanted: (name: string) => boolean,
): Promise<number> {
  let written = 0;
  await eachEntry(path, async (entry, zip) => {
    if (entry.fileName.endsWith('/') || !wanted(entry.fileName)) return;
    const target = safeDestination(destination, entry.fileName);
    if (target === null) {
      throw new Error(`The archive has an entry outside its folder: ${entry.fileName}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await pipeline(await entryStream(zip, entry), createWriteStream(target));
    written += 1;
  });
  return written;
}
