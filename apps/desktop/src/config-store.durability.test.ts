import { mkdtempSync, rmSync } from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigStore, newInstallConfig, type Cipher } from './config-store.js';
import { generateSecrets } from './secrets.js';

/**
 * `config.json` holds the key of the clinical data: a power cut right after the rename must not leave a
 * name that points at bytes the disk never got. The calls are recorded in order.
 */
const events: string[] = [];
const paths = new Map<number, string>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      paths.set(fd, basename(String(args[0])));
      return fd;
    },
    fsyncSync: (fd: number) => {
      events.push(`sync ${paths.get(fd) ?? String(fd)}`);
      actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      events.push(`rename ${basename(from)} -> ${basename(to)}`);
      actual.renameSync(from, to);
    },
  };
});

const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(plain, 'utf8'),
  decrypt: (data) => data.toString('utf8'),
};

let folder: string;
let file: string;

beforeEach(() => {
  events.length = 0;
  paths.clear();
  folder = mkdtempSync(join(tmpdir(), 'consulvia-config-durable-'));
  file = join(folder, 'config.json');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('writing config.json', () => {
  it('forces the new file to the disk before the rename that makes it the configuration', () => {
    const store = new ConfigStore(file, cipher);

    store.write(newInstallConfig(47800, generateSecrets()));

    const sync = events.indexOf('sync config.json.tmp');
    const rename = events.indexOf('rename config.json.tmp -> config.json');
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(rename).toBeGreaterThan(sync);
  });

  it('forces the copy it keeps (config.json.bak) to the disk too, before it replaces the file', () => {
    const store = new ConfigStore(file, cipher);
    store.write(newInstallConfig(47800, generateSecrets()));
    events.length = 0;

    store.update((config) => {
      config.port = 47801;
    });

    expect(events).toEqual(
      expect.arrayContaining([
        'sync config.json.tmp',
        'sync config.json.bak',
        'rename config.json.tmp -> config.json',
      ]),
    );
    expect(events.indexOf('sync config.json.bak')).toBeLessThan(
      events.indexOf('rename config.json.tmp -> config.json'),
    );
  });
});
