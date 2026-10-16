import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/**
 * Bundles the API and worker into `dist/main.js` so `node dist/main.js api` runs without a
 * TypeScript loader.
 *
 * Workspace packages (`@consultorio/*`, such as `@consultorio/contracts`) export raw TypeScript, so they are
 * inlined. Third-party runtime dependencies stay external and are installed into the image
 * (`pnpm deploy --prod`), which keeps native modules and their licences intact.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>;
};

const external = Object.keys(manifest.dependencies ?? {}).filter(
  (name) => !name.startsWith('@consultorio/'),
);

await rm(new URL('../dist', import.meta.url), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: { main: 'src/main/main.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
});
