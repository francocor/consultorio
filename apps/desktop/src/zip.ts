import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import yauzl from 'yauzl';
import yazl from 'yazl';

export type ZipSource =
  { name: string; content: string | Buffer } | { name: string; file: string; compress?: boolean };

/** Leftovers of an interrupted write of the API (`.tmp`, `.moving`); a backup never carries them. */
const TRANSIENT = /\.(?:tmp|moving)$/i;

/** Every file under `root` as `{ file, name }`, the name relative with forward slashes. */
export async function listFiles(
  root: string,
  prefix = '',
  include: (name: string) => boolean = () => true,
): Promise<{ file: string; name: string }[]> {
  const result: { file: string; name: string }[] = [];
  async function visit(folder: string, relative: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(folder, entry.name), name);
      else if (entry.isFile() && include(name)) {
        result.push({ file: join(folder, entry.name), name: `${prefix}${name}` });
      }
    }
  }
  await visit(root, '');
  return result;
}

export const isBackupFile = (name: string) => !TRANSIENT.test(name);

/**
 * Writes a zip next to `target` and renames it into place when it is complete, so a backup either exists
 * whole or does not exist. Large entries are streamed; nothing is read into memory whole.
 */
export async function writeZip(target: string, sources: Iterable<ZipSource>): Promise<void> {
  const partial = `${target}.partial`;
  await mkdir(dirname(target), { recursive: true });
  const zip = new yazl.ZipFile();
  for (const source of sources) {
    if ('content' in source) {
      zip.addBuffer(
        typeof source.content === 'string' ? Buffer.from(source.content, 'utf8') : source.content,
        source.name,
      );
    } else {
      zip.addFile(source.file, source.name, { compress: source.compress ?? true });
    }
  }
  zip.end();
  // A file that goes away before it is read (the API moves documents between folders) raises 'error'
  // on the zip, not on the stream, and the stream would then wait for it forever.
  const output = createWriteStream(partial);
  const failed = new Promise<never>((_resolve, reject) => {
    zip.once('error', (error: Error) => {
      output.destroy();
      reject(error);
    });
  });
  try {
    await Promise.race([pipeline(zip.outputStream, output), failed]);
    await rename(partial, target);
  } catch (error) {
    output.destroy();
    await rm(partial, { force: true });
    throw error;
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveOpen, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(error);
      else resolveOpen(zip);
    });
  });
}

/**
 * Walks the entries of a zip, one at a time. `visit` returns `true` to keep reading and may read the
 * entry's stream; an entry it does not open is skipped.
 */
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

/** The text of one entry, or `null` when the zip has none with that name. */
export async function readZipText(path: string, name: string): Promise<string | null> {
  let text: string | null = null;
  await eachEntry(path, async (entry, zip) => {
    if (entry.fileName !== name) return;
    const stream = await entryStream(zip, entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    text = Buffer.concat(chunks).toString('utf8');
  });
  return text;
}

/** Where `name` lands under `root`, or `null` when it would escape it (a "zip slip" entry). */
export function safeDestination(root: string, name: string): string | null {
  if (
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  ) {
    return null;
  }
  const base = resolve(root);
  const target = resolve(base, ...name.split('/'));
  return target.startsWith(base + sep) ? target : null;
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
    if (target === null)
      throw new Error(`The archive has an entry outside its folder: ${entry.fileName}`);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(await entryStream(zip, entry), createWriteStream(target));
    written += 1;
  });
  return written;
}

/** The size of a file in bytes, or 0 when it is not there. */
export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
