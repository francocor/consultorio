import { spawn } from 'node:child_process';
import { cp, copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleCrt, bundleCrtBesideAddons } from './crt.js';
import { makeIcons } from './make-icons.js';
import { dllClosure } from './pe-imports.js';
import { ensureEdbArchive, stageTools } from './pg-tools.js';

/**
 * Lays out everything the installed program needs next to the shell, in `stage/` (the same layout
 * `src/resources.ts` describes and the installer copies into `resources/`):
 *
 *   api/       the API bundle (`pnpm --filter @consultorio/api build`), its assets and its production modules
 *   web/       the web build
 *   postgres/  PostgreSQL 17: initdb, pg_ctl, postgres and only the DLLs they load
 *   tools/     pg_dump and pg_restore from the official EnterpriseDB build
 *   sql/       the role script of the repository
 *   icons/     the tray and window icons
 *
 * `electron-builder` takes `stage/` as it is; `pnpm start` runs the shell against it.
 */
export const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
export const repoRoot = join(desktopRoot, '..', '..');
export const stageDir = join(desktopRoot, 'stage');
export const buildDir = join(desktopRoot, 'build');

const step = (message: string) => {
  console.log(`\n[stage] ${message}`);
};

/** Runs pnpm the way the user's pnpm was started: with the same script, so the version is the same. */
export function pnpm(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const script = process.env['npm_execpath'];
  const [file, prefix]: [string, string[]] =
    script !== undefined && script.includes('pnpm')
      ? [process.execPath, [script]]
      : ['corepack', ['pnpm']];
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...prefix, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
      shell: file === 'corepack',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pnpm ${args.join(' ')} exited with code ${String(code)}`));
    });
  });
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size;
  }
  return total;
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

async function stageApi(): Promise<void> {
  const deploy = join(buildDir, 'api-deploy');
  step(
    'production modules of the API (pnpm deploy, hoisted so the copy has real folders, not links)',
  );
  await rm(deploy, { recursive: true, force: true });
  await pnpm(['--filter', '@consultorio/api', 'deploy', '--prod', '--legacy', deploy], {
    env: { npm_config_node_linker: 'hoisted' },
  });

  const target = join(stageDir, 'api');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(join(repoRoot, 'apps', 'api', 'dist'), join(target, 'dist'), { recursive: true });
  await cp(join(repoRoot, 'apps', 'api', 'assets'), join(target, 'assets'), { recursive: true });
  // `"type": "module"` in this file is what makes `dist/main.js` an ES module.
  await copyFile(join(deploy, 'package.json'), join(target, 'package.json'));
  await cp(join(deploy, 'node_modules'), join(target, 'node_modules'), {
    recursive: true,
    dereference: true,
  });
  // Tools for running scripts from the package manager; nothing in the app reads them.
  await rm(join(target, 'node_modules', '.bin'), { recursive: true, force: true });
  for (const leftover of ['.modules.yaml', '.pnpm', '.pnpm-workspace-state-v1.json']) {
    await rm(join(target, 'node_modules', leftover), { recursive: true, force: true });
  }
  await rm(deploy, { recursive: true, force: true });
  const addons = await bundleCrtBesideAddons(join(target, 'node_modules'));
  console.log(`[stage] Visual C++ runtime bundled beside: ${addons.join(', ')}`);
  console.log(`[stage] api: ${megabytes(await directorySize(target))}`);
}

async function stageWeb(): Promise<void> {
  step('web build');
  const target = join(stageDir, 'web');
  await rm(target, { recursive: true, force: true });
  await cp(join(repoRoot, 'apps', 'web', 'dist'), target, { recursive: true });
  // The build manifest and the source maps are for tools and debugging, not for the clinic's PC.
  await rm(join(target, '.vite'), { recursive: true, force: true });
  console.log(`[stage] web: ${megabytes(await directorySize(target))}`);
}

/** The folder with `bin`, `lib` and `share` of PostgreSQL, from the package of the server binaries. */
async function embeddedPostgresFolder(): Promise<string> {
  const candidate = join(
    desktopRoot,
    'node_modules',
    '@embedded-postgres',
    'windows-x64',
    'native',
  );
  try {
    await stat(join(candidate, 'bin', 'postgres.exe'));
  } catch {
    throw new Error(
      'The PostgreSQL server binaries are missing. They come from the optional dependency ' +
        '@embedded-postgres/windows-x64, which only installs on Windows x64: build the installer on Windows.',
    );
  }
  return candidate;
}

const SERVER_PROGRAMS = ['initdb.exe', 'pg_ctl.exe', 'postgres.exe'];

async function stagePostgres(): Promise<void> {
  step('PostgreSQL server');
  const source = await embeddedPostgresFolder();
  const target = join(stageDir, 'postgres');
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, 'bin'), { recursive: true });

  // The programs, the extension modules of lib/ (they load their own libraries from bin/) and everything
  // those import. The rest of bin/ (the graphical tools, the client programs) stays behind.
  const libModules = (await readdir(join(source, 'lib')))
    .filter((name) => name.toLowerCase().endsWith('.dll'))
    .map((name) => join(source, 'lib', name));
  const roots = [...SERVER_PROGRAMS.map((name) => join(source, 'bin', name)), ...libModules];
  const { found, system } = dllClosure(join(source, 'bin'), roots);
  for (const name of new Set([...SERVER_PROGRAMS, ...found])) {
    await copyFile(join(source, 'bin', name), join(target, 'bin', name));
  }
  await cp(join(source, 'lib'), join(target, 'lib'), { recursive: true });
  await cp(join(source, 'share'), join(target, 'share'), { recursive: true });
  // Documentation of the server and translations of its messages are not needed to run it.
  await rm(join(target, 'share', 'doc'), { recursive: true, force: true });
  console.log(`[stage] postgres: ${megabytes(await directorySize(target))}`);
  const crt = await bundleCrt(join(target, 'bin'), system);
  console.log(`[stage] Visual C++ runtime bundled app-locally: ${crt.join(', ')}`);
}

async function stageBackupTools(): Promise<void> {
  step('pg_dump and pg_restore');
  const archive = await ensureEdbArchive(join(buildDir, 'cache'));
  await stageTools(archive, join(stageDir, 'tools'));
}

async function stageSql(): Promise<void> {
  step('role script');
  await mkdir(join(stageDir, 'sql'), { recursive: true });
  await copyFile(
    join(repoRoot, 'infra', 'postgres', 'init', '01-roles.sql'),
    join(stageDir, 'sql', '01-roles.sql'),
  );
}

async function stageIcons(): Promise<void> {
  step('icons');
  await makeIcons({
    source: join(repoRoot, 'apps', 'web', 'public', 'icons', 'icon.svg'),
    buildDir,
    iconsDir: join(stageDir, 'icons'),
  });
}

export interface StageOptions {
  /** Do not rebuild the API and the web app (a build of each is already in `dist/`). */
  skipBuild?: boolean;
}

export async function stage(options: StageOptions = {}): Promise<void> {
  const started = Date.now();
  await mkdir(stageDir, { recursive: true });
  if (options.skipBuild !== true) {
    step('building the API bundle');
    await pnpm(['--filter', '@consultorio/api', 'build']);
    step('building the web app');
    await pnpm(['--filter', '@consultorio/web', 'build']);
  }
  await stageApi();
  await stageWeb();
  await stagePostgres();
  await stageBackupTools();
  await stageSql();
  await stageIcons();
  await writeFile(
    join(stageDir, 'STAGED.txt'),
    `Staged by apps/desktop/scripts/stage.ts at ${new Date().toISOString()}.\nThis folder is generated; do not edit it.\n`,
  );
  console.log(
    `\n[stage] done in ${String(Math.round((Date.now() - started) / 1000))} s: ${stageDir}`,
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await stage({ skipBuild: process.argv.includes('--skip-build') });
}
