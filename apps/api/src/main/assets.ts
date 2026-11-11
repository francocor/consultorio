import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where data assets (the common-password list) live relative to the process: next to the working
 * directory in the container (`/app/assets`) and when started from `apps/api`, or two folders up
 * from `src/main` when started from the repository root.
 */
function defaultRoots(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.cwd(),
    resolve(here, '..'),
    resolve(here, '../..'),
    resolve(here, '../../apps/api'),
  ];
}

/**
 * The path of a bundled data asset. It looks under `assets/` of each root, in order, and throws a
 * clear error naming what it could not find: starting the API without its password list would
 * silently weaken the password policy, so a missing asset must stop the process.
 */
export function findAsset(name: string, roots: readonly string[] = defaultRoots()): string {
  for (const root of roots) {
    const candidate = join(root, 'assets', name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Data asset "${name}" not found. Looked under: ${roots.map((root) => join(root, 'assets')).join(', ')}`,
  );
}
