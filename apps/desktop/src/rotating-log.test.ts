import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRotatingLog } from './rotating-log.js';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-log-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the rotating log', () => {
  it('appends to the file and creates the folder', () => {
    const file = join(folder, 'logs', 'api.log');
    const log = createRotatingLog(file);

    log.write('one\n');
    log.write('two\n');

    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  it('moves a full file aside and keeps only the newest few', () => {
    const file = join(folder, 'api.log');
    const log = createRotatingLog(file, { maxBytes: 10, keep: 2 });

    for (const line of ['aaaaaaaaaa\n', 'bbbbbbbbbb\n', 'cccccccccc\n', 'dddddddddd\n'])
      log.write(line);

    expect(readFileSync(file, 'utf8')).toBe('dddddddddd\n');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('cccccccccc\n');
    expect(readFileSync(`${file}.2`, 'utf8')).toBe('bbbbbbbbbb\n');
    expect(existsSync(`${file}.3`)).toBe(false);
  });

  it('continues after the size of an existing file, so a restart does not skip the rotation', () => {
    const file = join(folder, 'api.log');
    createRotatingLog(file, { maxBytes: 10 }).write('aaaaaaaaaa\n');

    createRotatingLog(file, { maxBytes: 10 }).write('bbbbbbbbbb\n');

    expect(readFileSync(`${file}.1`, 'utf8')).toBe('aaaaaaaaaa\n');
    expect(readFileSync(file, 'utf8')).toBe('bbbbbbbbbb\n');
  });

  it('never throws when the file cannot be written', () => {
    const log = createRotatingLog(join(folder, 'api.log'));
    rmSync(folder, { recursive: true, force: true });

    expect(() => {
      log.write('lost\n');
    }).not.toThrow();
  });
});
