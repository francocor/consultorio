import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { extractZip } from '../src/zip.js';

import { bundleCrt } from './crt.js';
import { dllClosure } from './pe-imports.js';

/**
 * The PostgreSQL client tools for backups. The server binaries in `@embedded-postgres/windows-x64` have
 * no `pg_dump` or `pg_restore`, so they come from the official EnterpriseDB build of the same release
 * (the package repackages it). The archive is downloaded once, checked against the SHA-256 pinned below,
 * and only the two programs and the DLLs they load are kept.
 *
 * To move to another release: change the three values, run `pnpm --filter @consultorio/desktop stage`
 * (it fails with the new hash, which it prints) and pin that hash after checking where it came from.
 */
export const EDB_ARCHIVE = {
  version: '17.10-1',
  url: 'https://get.enterprisedb.com/postgresql/postgresql-17.10-1-windows-x64-binaries.zip',
  sha256: 'f9aafca58e7026a1ef2caeee711acf761671e57904d430adc85f468374f5a821',
  bytes: 333_925_750,
} as const;

export const TOOLS = ['pg_dump.exe', 'pg_restore.exe'] as const;

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** The pinned archive, from the cache when it is there and intact, else downloaded. */
export async function ensureEdbArchive(cacheDir: string): Promise<string> {
  const file = join(cacheDir, `postgresql-${EDB_ARCHIVE.version}-windows-x64-binaries.zip`);
  await mkdir(cacheDir, { recursive: true });
  if (existsSync(file)) {
    if ((await sha256Of(file)) === EDB_ARCHIVE.sha256) return file;
    console.warn(`[tools] ${file} does not match the pinned SHA-256; downloading it again`);
    await rm(file, { force: true });
  }
  console.log(
    `[tools] downloading ${EDB_ARCHIVE.url} (${String(Math.round(EDB_ARCHIVE.bytes / 1e6))} MB)`,
  );
  const response = await fetch(EDB_ARCHIVE.url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download the EnterpriseDB archive (HTTP ${String(response.status)}). ` +
        'Without it the installer would have no pg_dump and no backups, so the build stops. ' +
        `Download ${EDB_ARCHIVE.url} by hand into ${cacheDir} and run the build again.`,
    );
  }
  const partial = `${file}.partial`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
  const actual = await sha256Of(partial);
  if (actual !== EDB_ARCHIVE.sha256) {
    await rm(partial, { force: true });
    throw new Error(
      `The EnterpriseDB archive does not match the pinned SHA-256.\n  expected ${EDB_ARCHIVE.sha256}\n  got      ${actual}`,
    );
  }
  await rename(partial, file);
  return file;
}

/** Puts `pg_dump.exe`, `pg_restore.exe` and the DLLs they need in `targetDir`. */
export async function stageTools(archive: string, targetDir: string): Promise<string[]> {
  const scratch = `${targetDir}.extract`;
  await rm(scratch, { recursive: true, force: true });
  await extractZip(archive, scratch, (name) => /^pgsql\/bin\/[^/]+\.(?:dll|exe)$/.test(name));
  const binDir = join(scratch, 'pgsql', 'bin');
  try {
    const { found, system } = dllClosure(
      binDir,
      TOOLS.map((tool) => join(binDir, tool)),
    );
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    const names = [...TOOLS, ...found].sort();
    for (const name of names) await copyFile(join(binDir, name), join(targetDir, name));
    const present = new Set((await readdir(targetDir)).map((name) => name.toLowerCase()));
    for (const name of names) {
      if (!present.has(name.toLowerCase()))
        throw new Error(`${name} did not make it to ${targetDir}`);
    }
    console.log(`[tools] ${names.join(', ')}`);
    const crt = await bundleCrt(targetDir, system);
    console.log(`[tools] Visual C++ runtime bundled app-locally: ${crt.join(', ')}`);
    return crt;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
