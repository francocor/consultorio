#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { planShards, runShards, scanTree } from './shards.js';

/**
 * `pnpm lint`: ESLint over the whole repository, in as many processes as the heap of one needs
 * (see `shards.js`). Flags go to ESLint as they are (`pnpm lint --fix`). Name files or folders and
 * the sharding is skipped: ESLint lints exactly those, in one process.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = fileURLToPath(
  new URL('../../../node_modules/eslint/bin/eslint.js', import.meta.url),
);

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [eslint, ...args], { cwd: root, stdio: 'inherit' });
    child.on('error', () => {
      resolve(1);
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

const given = process.argv.slice(2);
if (given.some((argument) => !argument.startsWith('-'))) {
  process.exitCode = await run(given);
} else {
  process.exitCode = await runShards(planShards(scanTree(root)), given, { run });
}
