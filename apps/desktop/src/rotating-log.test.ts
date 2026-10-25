import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRotatingLog, rotateBySize } from './rotating-log.js';

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

describe('a log that is told what to leave out', () => {
  it('writes what the transform returns', () => {
    const file = join(folder, 'shell.log');
    const log = createRotatingLog(file, { transform: (text) => text.replaceAll('secret', '***') });

    log.write('a secret line\n');

    expect(readFileSync(file, 'utf8')).toBe('a *** line\n');
  });
});

describe('a rotation that cannot move the file', () => {
  it('keeps logging and stays bounded when the place for the old file is taken by a folder', () => {
    const file = join(folder, 'api.log');
    // Nothing can be renamed over a non-empty folder: the old rotation threw here, on every write, for ever.
    mkdirSync(join(file + '.1', 'inner'), { recursive: true });
    const log = createRotatingLog(file, { maxBytes: 10, keep: 1 });

    for (const line of ['aaaaaaaaaa\n', 'bbbbbbbbbb\n', 'cccccccccc\n']) log.write(line);

    // The newest line is on the disk, and the file did not grow without limit.
    expect(readFileSync(file, 'utf8')).toBe('cccccccccc\n');
  });
});

describe('rotating a file by size before it is opened by another program', () => {
  it('moves a file over the limit aside and leaves room for a new one (PostgreSQL appends to its own)', () => {
    const file = join(folder, 'postgres.log');
    writeFileSync(file, 'x'.repeat(20));

    const moved = rotateBySize(file, { maxBytes: 10, keep: 2 });

    expect(moved).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(20));
  });

  it('leaves a small file, or a missing one, alone', () => {
    const file = join(folder, 'postgres.log');
    expect(rotateBySize(file, { maxBytes: 10, keep: 2 })).toBe(false);

    writeFileSync(file, 'small');

    expect(rotateBySize(file, { maxBytes: 10, keep: 2 })).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('small');
  });
});
