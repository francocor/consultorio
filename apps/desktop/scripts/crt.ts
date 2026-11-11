import { existsSync } from 'node:fs';
import { copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { importedDlls } from './pe-imports.js';

/**
 * PostgreSQL and its tools are built with Visual C++ and load `VCRUNTIME140.dll` and `MSVCP140.dll`, which a
 * clean Windows does not have (they come with the "Visual C++ Redistributable" that many programs install,
 * but not all PCs have). Microsoft allows shipping these files with an application ("app-local deployment"),
 * so the installer carries the ones of the machine that builds it, next to the programs that need them.
 * The Universal CRT (`api-ms-win-crt-*`) is part of Windows 10 and 11 and is not bundled.
 */
const CRT_DLL = /^(?:vcruntime140(?:_1)?|msvcp140(?:_1|_2)?|concrt140|vccorlib140)\.dll$/i;

export function isCrtDll(name: string): boolean {
  return CRT_DLL.test(name);
}

/**
 * Copies the Visual C++ runtime DLLs named in `imported` (and the ones those need) from the Windows folder
 * of this machine into `targetDir`. Returns the names it copied.
 */
export async function bundleCrt(
  targetDir: string,
  imported: readonly string[],
  systemDir = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32'),
): Promise<string[]> {
  const wanted = new Set(imported.filter(isCrtDll).map((name) => name.toLowerCase()));
  const copied: string[] = [];
  const queue = [...wanted];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined) break;
    const source = join(systemDir, name);
    if (!existsSync(source)) {
      throw new Error(
        `${name} is needed by PostgreSQL and was not found in ${systemDir}. ` +
          'Install the "Microsoft Visual C++ 2015-2022 Redistributable (x64)" on the machine that builds the installer.',
      );
    }
    await copyFile(source, join(targetDir, name));
    copied.push(name);
    for (const dependency of importedDlls(source)) {
      const lower = dependency.toLowerCase();
      if (isCrtDll(lower) && !wanted.has(lower)) {
        wanted.add(lower);
        queue.push(lower);
      }
    }
  }
  return copied;
}

/** Every folder under `root` that holds a native addon (`.node`), with the DLLs each one imports. */
async function addonImports(root: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  async function visit(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.node')) {
        result.set(folder, [...(result.get(folder) ?? []), ...importedDlls(path)]);
      }
    }
  }
  await visit(root);
  return result;
}

/**
 * Native addons built with Visual C++ (`@node-rs/argon2`) have the same need: Node loads an addon with its own
 * folder first in the search path, so the runtime goes right beside the `.node` file. Returns the folders
 * that got DLLs.
 */
export async function bundleCrtBesideAddons(root: string): Promise<string[]> {
  const touched: string[] = [];
  for (const [folder, imports] of await addonImports(root)) {
    if ((await bundleCrt(folder, imports)).length > 0) touched.push(folder);
  }
  return touched;
}
