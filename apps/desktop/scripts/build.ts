import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/**
 * Bundles the main process into `dist/main.cjs`. Everything except Electron itself is inlined (the `pg`
 * client, the zip readers, the shared contracts), so the installed app carries no `node_modules`.
 * `pnpm --filter @consultorio/desktop build` runs in CI too: it needs no Electron binary.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildShell(options: { quiet?: boolean } = {}): Promise<void> {
  await rm(`${root}dist`, { recursive: true, force: true });
  await build({
    absWorkingDir: root,
    entryPoints: { main: 'src/main.ts' },
    outfile: 'dist/main.cjs',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: true,
    // `pg` tries `pg-native` and falls back to JavaScript when it is not there.
    external: ['electron', 'pg-native'],
    logLevel: options.quiet === true ? 'silent' : 'info',
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildShell();
}
