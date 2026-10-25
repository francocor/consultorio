import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OUTBOX_MAX_AGE_MS, pruneOutbox } from './outbox.js';

let folder: string;
const now = Date.UTC(2026, 9, 24, 12, 0, 0);

function entry(name: string, ageMs: number): void {
  const path = join(folder, name);
  writeFileSync(path, 'x');
  const when = new Date(now - ageMs);
  utimesSync(path, when, when);
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-outbox-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the outbox', () => {
  it('deletes the messages older than a week, both files of each, and keeps the rest', async () => {
    const day = 24 * 60 * 60 * 1000;
    entry('20260101T000000000Z-aaaaaaaa.eml', 30 * day);
    entry('20260101T000000000Z-aaaaaaaa.json', 30 * day);
    entry('20261018T110000000Z-bbbbbbbb.eml', 6 * day);
    entry('20261018T110000000Z-bbbbbbbb.json', 6 * day);
    entry('20261024T110000000Z-cccccccc.eml', 1000);

    const deleted = await pruneOutbox(folder, () => now);

    expect(deleted).toBe(2);
    expect(existsSync(join(folder, '20260101T000000000Z-aaaaaaaa.eml'))).toBe(false);
    expect(existsSync(join(folder, '20260101T000000000Z-aaaaaaaa.json'))).toBe(false);
    expect(existsSync(join(folder, '20261018T110000000Z-bbbbbbbb.eml'))).toBe(true);
    expect(existsSync(join(folder, '20261024T110000000Z-cccccccc.eml'))).toBe(true);
    expect(OUTBOX_MAX_AGE_MS).toBe(7 * day);
  });

  it('ignores what is not mail, and folders', async () => {
    entry('notes.txt', 90 * 24 * 60 * 60 * 1000);
    mkdirSync(join(folder, 'old.json'));

    expect(await pruneOutbox(folder, () => now)).toBe(0);
    expect(existsSync(join(folder, 'notes.txt'))).toBe(true);
    expect(existsSync(join(folder, 'old.json'))).toBe(true);
  });

  it('does nothing when the folder does not exist', async () => {
    expect(await pruneOutbox(join(folder, 'nowhere'), () => now)).toBe(0);
  });
});
