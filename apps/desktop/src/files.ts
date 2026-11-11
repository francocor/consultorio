import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/** Leftovers of an interrupted write of the API (`.tmp`, `.moving`); a backup never carries them. */
const TRANSIENT = /\.(?:tmp|moving)$/i;

export const isBackupFile = (name: string) => !TRANSIENT.test(name);

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

/** Where `name` lands under `root`, or `null` when it would escape it (a "zip slip" entry). */
export function safeDestination(root: string, name: string): string | null {
  const backslash = String.fromCharCode(92);
  if (
    name.includes('\0') ||
    name.includes(backslash) ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  ) {
    return null;
  }
  const base = resolve(root);
  const target = resolve(base, ...name.split('/'));
  return target.startsWith(base + sep) ? target : null;
}

/** The size of a file in bytes, or 0 when it is not there. */
export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
