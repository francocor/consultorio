import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_FILES_PER_SHARD, planShards, runShards, scanTree, weightOf } from './shards.js';

/** A directory node the way `scanTree` builds it, from a compact description. */
function dir(path, files, dirs = []) {
  return {
    path,
    files: files.map((name) => `${path}/${name}`),
    dirs,
  };
}

/** Every file a plan covers, expanding a directory into the files below it. */
function coveredBy(shards, root) {
  const filesUnder = (node) => [...node.files, ...node.dirs.flatMap(filesUnder)];
  const find = (node, path) => {
    if (node.path === path) return node;
    for (const child of node.dirs) {
      const found = find(child, path);
      if (found) return found;
    }
    return undefined;
  };
  return shards.flatMap((shard) =>
    shard.paths.flatMap((path) => {
      const node = find(root, path);
      return node ? filesUnder(node) : [path];
    }),
  );
}

describe('planShards', () => {
  it('lints a small tree in one process, as a single directory', () => {
    const root = dir('.', ['a.js'], [dir('./src', ['b.ts', 'c.ts'])]);

    expect(weightOf(root)).toBe(3);
    expect(planShards(root, 10)).toEqual([{ paths: ['.'], size: 3 }]);
  });

  it('splits a tree over the limit along its directories and keeps every shard within it', () => {
    const root = dir(
      '.',
      [],
      [
        dir(
          './apps',
          [],
          [dir('./apps/api', ['1', '2', '3', '4']), dir('./apps/web', ['1', '2', '3'])],
        ),
        dir('./packages', ['x', 'y']),
      ],
    );

    const shards = planShards(root, 5);

    // api (4) and web (3) do not fit together; packages (2) joins the web shard.
    expect(shards).toEqual([
      { paths: ['./apps/api'], size: 4 },
      { paths: ['./apps/web', './packages'], size: 5 },
    ]);
    for (const shard of shards) expect(shard.size).toBeLessThanOrEqual(5);
  });

  it('covers every file exactly once, whatever the shape of the tree', () => {
    const root = dir(
      '.',
      ['root.js', 'config.js'],
      [
        dir('./a', ['1', '2', '3'], [dir('./a/deep', ['4', '5', '6', '7'])]),
        dir('./b', ['1']),
        dir('./c', ['1', '2', '3', '4', '5', '6']),
      ],
    );

    for (const max of [3, 4, 6, 7, 20]) {
      const covered = coveredBy(planShards(root, max), root);
      const expected = [
        './root.js',
        './config.js',
        ...['1', '2', '3'].map((n) => `./a/${n}`),
        ...['4', '5', '6', '7'].map((n) => `./a/deep/${n}`),
        './b/1',
        ...['1', '2', '3', '4', '5', '6'].map((n) => `./c/${n}`),
      ];
      expect(covered.slice().sort(), `max ${String(max)}`).toEqual(expected.slice().sort());
    }
  });

  it('lists the files of a directory that is too big on its own, one by one', () => {
    const root = dir('./big', ['1', '2', '3', '4', '5', '6', '7']);

    const shards = planShards(root, 3);

    expect(shards.map((shard) => shard.paths)).toEqual([
      ['./big/1', './big/2', './big/3'],
      ['./big/4', './big/5', './big/6'],
      ['./big/7'],
    ]);
  });

  it('is the same plan every time (sorted, so two machines lint the same shards)', () => {
    const one = dir('./z', ['1', '2']);
    const two = dir('./a', ['1', '2']);
    const forward = planShards(dir('.', [], [one, two]), 2);
    const backward = planShards(dir('.', [], [two, one]), 2);

    expect(forward).toEqual(backward);
    expect(forward.map((shard) => shard.paths[0])).toEqual(['./a', './z']);
  });

  it('gives no shard for a tree without files', () => {
    expect(planShards(dir('.', [], [dir('./empty', [])]), 5)).toEqual([]);
  });

  it('keeps the default limit under what the default heap of Node holds', () => {
    // 398 files of the api tests peaked at 2.4 GB; the limit leaves room for the heavier folders.
    expect(MAX_FILES_PER_SHARD).toBeGreaterThanOrEqual(150);
    expect(MAX_FILES_PER_SHARD).toBeLessThanOrEqual(400);
  });
});

describe('scanTree', () => {
  let root;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lint-shards-'));
    const write = (path) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), '');
    };
    write('eslint.config.js');
    write('README.md');
    write('apps/api/src/a.ts');
    write('apps/api/src/b.tsx');
    write('apps/api/src/data.json');
    write('apps/api/node_modules/dep/index.js');
    write('apps/web/dist/bundle.js');
    write('.claude/skills/x/run.js');
    write('openspec/changes/tool.mjs');
    write('apps/web/src/c.mjs');
    write('apps/web/src/d.cjs');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('counts the files ESLint lints and skips folders no one lints', () => {
    const tree = scanTree(root, { isIgnored: (path) => path.startsWith('openspec') });

    expect(weightOf(tree)).toBe(5);
    const names = [];
    const walk = (node) => {
      names.push(...node.files);
      node.dirs.forEach(walk);
    };
    walk(tree);
    expect(names.sort()).toEqual([
      'apps/api/src/a.ts',
      'apps/api/src/b.tsx',
      'apps/web/src/c.mjs',
      'apps/web/src/d.cjs',
      'eslint.config.js',
    ]);
  });

  it('uses paths relative to the root, with forward slashes', () => {
    const tree = scanTree(root, { isIgnored: () => false });

    expect(tree.path).toBe('.');
    const api = tree.dirs.find((child) => child.path === 'apps');
    expect(api?.dirs.map((child) => child.path)).toEqual(['apps/api', 'apps/web']);
  });
});

describe('runShards', () => {
  const shards = [
    { paths: ['apps/api/src'], size: 2 },
    { paths: ['apps/web', 'packages'], size: 3 },
    { paths: ['e2e'], size: 1 },
  ];

  it('runs one process per shard, in order, with the extra arguments of the caller', async () => {
    const calls = [];
    const code = await runShards(shards, ['--max-warnings=0'], {
      run: (args) => {
        calls.push(args);
        return Promise.resolve(0);
      },
      log: () => undefined,
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      ['--max-warnings=0', 'apps/api/src'],
      ['--max-warnings=0', 'apps/web', 'packages'],
      ['--max-warnings=0', 'e2e'],
    ]);
  });

  it('goes on after a shard that fails, so one run reports every problem, and fails at the end', async () => {
    const calls = [];
    const code = await runShards(shards, [], {
      run: (args) => {
        calls.push(args);
        return Promise.resolve(args.includes('apps/api/src') ? 1 : 0);
      },
      log: () => undefined,
    });

    expect(calls).toHaveLength(3);
    expect(code).toBe(1);
  });

  it('fails when a shard cannot start (a crash is not a pass)', async () => {
    const code = await runShards(shards, [], {
      run: (args) => Promise.resolve(args.includes('e2e') ? 134 : 0),
      log: () => undefined,
    });

    expect(code).toBe(1);
  });
});
