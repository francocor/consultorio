import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { isIgnoredFolder } from './ignores.js';

/**
 * Type-aware linting keeps the whole TypeScript program of a package in memory, and what it
 * resolves grows with every file it lints. One `eslint .` over the monorepo ran out of the 4 GB of
 * heap that Node gives a process by default. So the lint runs as several processes, each over a
 * slice of the tree: a process starts with a clean heap, and the slices are planned from the files
 * on disk, so a new folder is covered without anyone editing a list.
 *
 * Measured on the merged tree of Stage 6: 398 files of the api tests peaked at 2.4 GB, 722 files of
 * the web at 2.7 GB, 1,096 files of the api sources at 3.4 GB. 300 files per process keeps the
 * heaviest slice at about 2 GB.
 */
export const MAX_FILES_PER_SHARD = 300;

const LINTED_FILE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
/** Never walked, whatever the config says (generated or installed code, and hidden folders). */
const NEVER_WALKED = new Set([
  'node_modules',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
]);

/** Files below a node, itself included. */
export function weightOf(node) {
  return node.files.length + node.dirs.reduce((sum, child) => sum + weightOf(child), 0);
}

/**
 * The tree of lintable files below `root`: `{ path, files, dirs }` with paths relative to `root`,
 * forward slashes, `.` for the root itself.
 *
 * @param {string} root absolute path of the repository
 * @param {{ isIgnored?: (relativePath: string) => boolean }} [options] extra folders to skip
 */
export function scanTree(root, { isIgnored = isIgnoredFolder } = {}) {
  const visit = (relativePath) => {
    const absolute = relativePath === '.' ? root : join(root, relativePath);
    const node = { path: relativePath, files: [], dirs: [] };
    const entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    );
    for (const entry of entries) {
      const child = relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || NEVER_WALKED.has(entry.name) || isIgnored(child))
          continue;
        const below = visit(child);
        if (weightOf(below) > 0) node.dirs.push(below);
      } else if (entry.isFile() && LINTED_FILE.test(entry.name) && !isIgnored(child)) {
        node.files.push(child);
      }
    }
    return node;
  };
  return visit('.');
}

/**
 * Splits the tree into shards of at most `max` files: `{ paths, size }`, where a path is a folder
 * that fits whole or one file of a folder that is too big on its own. Folders are taken in name
 * order and packed one after the other, so neighbours share a process and the plan is the same on
 * every machine.
 */
export function planShards(root, max = MAX_FILES_PER_SHARD) {
  const shards = [];
  let current = { paths: [], size: 0 };

  const place = (path, size) => {
    if (current.size > 0 && current.size + size > max) {
      shards.push(current);
      current = { paths: [], size: 0 };
    }
    current.paths.push(path);
    current.size += size;
  };

  const visit = (node) => {
    const size = weightOf(node);
    if (size === 0) return;
    if (size <= max) {
      place(node.path, size);
      return;
    }
    for (const file of node.files) place(file, 1);
    const dirs = [...node.dirs].sort((left, right) => (left.path < right.path ? -1 : 1));
    for (const child of dirs) visit(child);
  };

  visit(root);
  if (current.size > 0) shards.push(current);
  return shards;
}

/**
 * Runs the shards one after the other (a process each, so the heap of one never adds to the next).
 * A shard that fails does not stop the rest: one run reports every problem. The result is 0 only
 * when every shard exited with 0; a crash (an exit code that is not 0) counts as a failure.
 *
 * @param {{ paths: string[], size: number }[]} shards
 * @param {string[]} extraArguments flags for ESLint, in front of the paths of each shard
 * @param {{ run: (args: string[]) => Promise<number>, log?: (line: string) => void }} io
 */
export async function runShards(shards, extraArguments, { run, log = console.log }) {
  let failed = 0;
  for (const [index, shard] of shards.entries()) {
    const label = `${String(index + 1)}/${String(shards.length)}`;
    log(`[lint] ${label}: ${shard.paths.join(' ')} (${String(shard.size)} files)`);
    const started = Date.now();
    const code = await run([...extraArguments, ...shard.paths]);
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    if (code !== 0) {
      failed += 1;
      log(`[lint] ${label} failed with exit code ${String(code)} after ${seconds} s`);
    } else {
      log(`[lint] ${label} ok in ${seconds} s`);
    }
  }
  return failed === 0 ? 0 : 1;
}
