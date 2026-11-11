import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { Arch, build, Platform } from 'electron-builder';

import { buildShell } from './build.js';
import { builderConfig } from './builder-config.js';
import { buildDir, desktopRoot, stage, stageDir } from './stage.js';

/**
 * `pnpm --filter @consultorio/desktop dist`: builds the API and the web app, bundles the shell, stages
 * everything next to it and packs the installer into `release/Consulvia-Setup-<version>.exe`.
 */
const releaseDir = join(desktopRoot, 'release');

async function appDirectory(version: string): Promise<string> {
  const appDir = join(buildDir, 'app');
  await rm(appDir, { recursive: true, force: true });
  await mkdir(join(appDir, 'dist'), { recursive: true });
  await copyFile(join(desktopRoot, 'dist', 'main.cjs'), join(appDir, 'dist', 'main.cjs'));
  // The shell is a single file with no dependencies, so the packed application needs no package list.
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'consulvia',
        productName: 'Consulvia',
        version,
        description: 'Consulvia Desktop',
        author: 'Consulvia',
        main: 'dist/main.cjs',
      },
      null,
      2,
    )}\n`,
  );
  return appDir;
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Files electron-builder drops from everything it copies, whatever the config says. They carry nothing. */
const ALWAYS_DROPPED =
  /^(?:\.gitkeep|\.gitignore|\.gitattributes|\.npmignore|\.DS_Store|thumbs\.db)$/i;

/** Files under a folder, counted. */
async function countFiles(folder: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(join(folder, entry.name));
    else if (!ALWAYS_DROPPED.test(entry.name)) total += 1;
  }
  return total;
}

/**
 * What electron-builder copied is what was staged, file for file. It filters what it copies by rules made
 * for application files (it once left out the whole `node_modules` of the API), and a program that is
 * missing a module only fails on the clinic's PC.
 */
async function assertPacked(staged: string, resources: string): Promise<void> {
  for (const part of ['api', 'web', 'postgres', 'tools', 'sql', 'icons']) {
    const expected = await countFiles(join(staged, part));
    const packed = await countFiles(join(resources, part));
    if (expected !== packed) {
      throw new Error(
        `The installer carries ${String(packed)} files of "${part}" and the build staged ${String(expected)}`,
      );
    }
  }
  console.log('[dist] every staged file is in the installer');
}

export async function dist(
  options: {
    skipBuild?: boolean;
    reuseStage?: boolean;
    dirOnly?: boolean;
    /** Builds as this version instead of the one in package.json (the upgrade test builds 0.1.1 from 0.1.0). */
    version?: string;
  } = {},
): Promise<string> {
  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8')) as {
    version: string;
    devDependencies: Record<string, string>;
  };
  const version = options.version ?? manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`The version "${version}" is not x.y.z`);
  const electronVersion = manifest.devDependencies['electron'];
  if (electronVersion === undefined || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
    throw new Error('apps/desktop/package.json must pin electron to an exact version');
  }
  await buildShell();
  if (options.reuseStage === true && existsSync(join(stageDir, 'STAGED.txt'))) {
    console.log('[dist] reusing stage/ as it is');
  } else {
    await stage({ skipBuild: options.skipBuild === true });
  }
  const appDir = await appDirectory(version);

  await rm(releaseDir, { recursive: true, force: true });
  await build({
    // The packed application is the folder written above, with no dependency list of its own: pointing the
    // builder at the workspace package instead would pack the PostgreSQL binaries a second time as a "dependency".
    projectDir: appDir,
    targets: Platform.WINDOWS.createTarget(options.dirOnly === true ? 'dir' : 'nsis', Arch.x64),
    config: {
      ...builderConfig({
        stageDir,
        buildDir,
        outputDir: releaseDir,
        nsisInclude: join(desktopRoot, 'installer', 'installer.nsh'),
      }),
      electronVersion,
    },
  });

  await assertPacked(stageDir, join(releaseDir, 'win-unpacked', 'resources'));
  if (options.dirOnly === true) {
    console.log(`[dist] unpacked program (no installer): ${join(releaseDir, 'win-unpacked')}`);
    return join(releaseDir, 'win-unpacked');
  }

  const installer = join(releaseDir, `Consulvia-Setup-${version}.exe`);
  const { size } = await stat(installer);
  const digest = await sha256Of(installer);
  await writeFile(`${installer}.sha256`, `${digest} *${installer.split(/[\\/]/).pop() ?? ''}\n`);
  console.log(
    `\n[dist] ${installer}\n[dist] ${String(size)} bytes (${(size / 1024 / 1024).toFixed(1)} MB)\n[dist] sha256 ${digest}`,
  );
  return installer;
}

const versionArgument = process.argv
  .find((argument) => argument.startsWith('--version='))
  ?.slice('--version='.length);

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await dist({
    skipBuild: process.argv.includes('--skip-build'),
    reuseStage: process.argv.includes('--reuse-stage'),
    dirOnly: process.argv.includes('--dir-only'),
    ...(versionArgument === undefined ? {} : { version: versionArgument }),
  });
}
