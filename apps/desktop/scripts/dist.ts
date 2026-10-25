import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

export async function dist(options: { skipBuild?: boolean } = {}): Promise<string> {
  const manifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  await buildShell();
  await stage({ skipBuild: options.skipBuild === true });
  const appDir = await appDirectory(manifest.version);

  await rm(releaseDir, { recursive: true, force: true });
  await build({
    projectDir: desktopRoot,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    config: builderConfig({ appDir, stageDir, buildDir, outputDir: releaseDir }),
  });

  const installer = join(releaseDir, `Consulvia-Setup-${manifest.version}.exe`);
  const { size } = await stat(installer);
  const digest = await sha256Of(installer);
  await writeFile(`${installer}.sha256`, `${digest} *${installer.split(/[\\/]/).pop() ?? ''}\n`);
  console.log(
    `\n[dist] ${installer}\n[dist] ${String(size)} bytes (${(size / 1024 / 1024).toFixed(1)} MB)\n[dist] sha256 ${digest}`,
  );
  return installer;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await dist({ skipBuild: process.argv.includes('--skip-build') });
}
