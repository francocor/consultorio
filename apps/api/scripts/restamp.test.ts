import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeMigrationsFolder, snapshotId } from './migration-folder.js';
import { checkJournalFolder, restampJournal, type Journal } from './migration-journal.js';
import { restampFolder } from './restamp-migrations.js';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function folderOf(entries: { tag: string; when: number }[]): Promise<string> {
  const dir = await makeMigrationsFolder(entries);
  folders.push(dir);
  return dir;
}

const journalOf = (entries: { tag: string; when: number; idx?: number }[]): Journal => ({
  version: '7',
  dialect: 'postgresql',
  entries: entries.map((entry, position) => ({
    idx: entry.idx ?? position,
    version: '7',
    when: entry.when,
    tag: entry.tag,
    breakpoints: true,
  })),
});

describe('restampJournal', () => {
  it('raises the stamp of an entry that a merge put before a later one, one millisecond past it', () => {
    const merged = journalOf([
      { tag: '0320_notifications_core', when: 3000 },
      { tag: '0340_online_booking_links', when: 2500 },
      { tag: '0360_waitlist', when: 2600 },
    ]);

    const restamped = restampJournal(merged);

    expect(restamped.entries.map((entry) => entry.when)).toEqual([3000, 3001, 3002]);
  });

  it('keeps the stamp of every entry that already rises, so only the merged ones change', () => {
    const fine = journalOf([
      { tag: '0320_notifications_core', when: 3000 },
      { tag: '0340_online_booking_links', when: 4000 },
    ]);

    expect(restampJournal(fine)).toEqual(fine);
  });

  it('never touches the linear sequence of Stages 0 to 2 (below 0300): databases ran those entries with these stamps', () => {
    const merged = journalOf([
      { tag: '0034_encounter_links', when: 5000 },
      { tag: '0035_onboarding_state', when: 4000 },
      { tag: '0320_notifications_core', when: 4500 },
    ]);

    const restamped = restampJournal(merged);

    // The frozen entries stay as they were, even out of order; the first later one is raised.
    expect(restamped.entries.map((entry) => entry.when)).toEqual([5000, 4000, 4500]);
  });

  it('numbers idx 0, 1, 2 ... again, in the order of the file', () => {
    const merged = journalOf([
      { tag: '0320_notifications_core', when: 3000, idx: 36 },
      { tag: '0340_online_booking_links', when: 4000, idx: 36 },
    ]);

    expect(restampJournal(merged).entries.map((entry) => entry.idx)).toEqual([0, 1]);
  });
});

describe('restampFolder after two tracks were merged', () => {
  // Track B was written first (stamp 2500) and merged second: its entry is out of order, and its
  // snapshot still continues the snapshot both tracks branched from (0035).
  const MERGED = [
    { tag: '0035_onboarding_state', when: 2000 },
    { tag: '0320_notifications_core', when: 3000 },
    { tag: '0340_online_booking_links', when: 2500 },
  ];

  async function mergedFolder(): Promise<string> {
    const dir = await folderOf(MERGED);
    const path = join(dir, 'meta', '0340_snapshot.json');
    const snapshot = JSON.parse(await readFile(path, 'utf8')) as { prevId: string };
    snapshot.prevId = snapshotId('0035');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify(snapshot, null, 2));
    return dir;
  }

  it('starts out failing the check, and passes it once restamped', async () => {
    const dir = await mergedFolder();
    expect((await checkJournalFolder(dir)).map((problem) => problem.code).sort()).toEqual([
      'broken_snapshot_chain',
      'non_monotonic_when',
    ]);

    const report = await restampFolder(dir);

    expect(await checkJournalFolder(dir)).toEqual([]);
    expect(report.restamped).toEqual(['0340_online_booking_links']);
    expect(report.relinked).toEqual(['0340']);
  });

  it('re-chains the snapshots in the order of the journal', async () => {
    const dir = await mergedFolder();

    await restampFolder(dir);

    const snapshot = JSON.parse(
      await readFile(join(dir, 'meta', '0340_snapshot.json'), 'utf8'),
    ) as { id: string; prevId: string };
    expect(snapshot.prevId).toBe(snapshotId('0320'));
    expect(snapshot.id).toBe(snapshotId('0340'));
  });

  it('is idempotent: a second run changes nothing', async () => {
    const dir = await mergedFolder();
    await restampFolder(dir);
    const journalAfterFirst = await readFile(join(dir, 'meta', '_journal.json'), 'utf8');

    const second = await restampFolder(dir);

    expect(second).toEqual({ restamped: [], relinked: [], renumbered: false });
    expect(await readFile(join(dir, 'meta', '_journal.json'), 'utf8')).toBe(journalAfterFirst);
  });

  it('leaves a folder that is already right exactly as it was', async () => {
    const dir = await folderOf([
      { tag: '0035_onboarding_state', when: 2000 },
      { tag: '0320_notifications_core', when: 3000 },
    ]);
    const before = await readFile(join(dir, 'meta', '_journal.json'), 'utf8');

    const report = await restampFolder(dir);

    expect(report).toEqual({ restamped: [], relinked: [], renumbered: false });
    expect(await readFile(join(dir, 'meta', '_journal.json'), 'utf8')).toBe(before);
  });
});
