import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Imports every TypeScript module of a folder, keyed by file name, in name order.
 *
 * The folder is read when this is called. `import.meta.glob` is fixed when Vitest transforms the
 * file that holds it, and Vitest keeps that transform on disk: a file added to the folder later was
 * invisible until `node_modules/.vitest-cache` was removed, so a test passed or failed for a list
 * that was not the one on disk. Use this wherever the caller can wait for a promise.
 */
export async function discoverModules<T = Record<string, unknown>>(
  folder: string,
): Promise<Record<string, T>> {
  const names = readdirSync(folder)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .sort();
  const modules: Record<string, T> = {};
  for (const name of names) {
    modules[name] = (await import(/* @vite-ignore */ pathToFileURL(join(folder, name)).href)) as T;
  }
  return modules;
}
