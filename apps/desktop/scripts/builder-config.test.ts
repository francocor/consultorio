import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { builderConfig } from './builder-config.js';

const installerFolder = join(fileURLToPath(new URL('..', import.meta.url)), 'installer');
const nsisInclude = join(installerFolder, 'installer.nsh');

describe('the installer', () => {
  it('is a one-click installer for the current user that includes the steps of installer.nsh', () => {
    const config = builderConfig({
      stageDir: 'stage',
      buildDir: 'build',
      outputDir: 'release',
      nsisInclude,
    });

    expect(config.nsis).toMatchObject({
      oneClick: true,
      perMachine: false,
      include: nsisInclude,
      deleteAppDataOnUninstall: false,
    });
  });

  it('asks a running Consulvia to quit by itself before anything is ended by force', () => {
    const file = readFileSync(nsisInclude, 'utf8');
    const start = file.indexOf('!macro customCheckAppRunning');
    expect(start).toBeGreaterThan(-1);
    // The comments above the macro talk about the force; the steps are what is compared.
    const script = file.slice(start);
    const quit = script.indexOf('--quit');
    const force = script.indexOf('taskkill /F');
    expect(quit).toBeGreaterThan(-1);
    expect(force).toBeGreaterThan(quit);
    // It waits for the program to go, for a minute and a half at the most, before the last resort.
    expect(script).toMatch(/\$R1 < 90/);
  });
});
