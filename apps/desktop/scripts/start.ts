import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildShell } from './build.js';

/**
 * `pnpm --filter @consultorio/desktop start`: bundles the shell and runs it with the Electron of the
 * workspace against the staged files (`pnpm stage` first). The data goes to `%LOCALAPPDATA%\Consulvia`, or to
 * `CONSULVIA_DATA_DIR` if you set it; use that to keep a development run apart from a real install.
 */
const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const electronPath = createRequire(import.meta.url)('electron') as string;

await buildShell({ quiet: true });
const child = spawn(electronPath, [desktopRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CONSULVIA_RESOURCES: join(desktopRoot, 'stage') },
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
