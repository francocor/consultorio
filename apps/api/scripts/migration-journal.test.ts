import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeMigrationsFolder, snapshotId } from './migration-folder.js';
import {
  TRACK_RANGES,
  checkJournalFolder,
  prefixOf,
  stageRangeOf,
  type JournalProblem,
} from './migration-journal.js';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function folderOf(entries: { tag: string; when: number }[]): Promise<string> {
  const dir = await makeMigrationsFolder(entries);
  folders.push(dir);
  return dir;
}

const codes = (problems: JournalProblem[]) => problems.map((problem) => problem.code);

describe('migration ranges', () => {
  it('reads the number a tag starts with', () => {
    expect(prefixOf('0035_onboarding_state')).toBe(35);
    expect(prefixOf('0320_notifications_core')).toBe(320);
    expect(prefixOf('onboarding')).toBeNull();
    expect(prefixOf('35_short')).toBeNull();
  });

  it('keeps Stages 0 to 2 as one linear sequence below 0300 and gives each later stage a hundred', () => {
    expect(stageRangeOf(0)).toBe('stage 0 to 2');
    expect(stageRangeOf(35)).toBe('stage 0 to 2');
    expect(stageRangeOf(41)).toBe('stage 0 to 2');
    expect(stageRangeOf(299)).toBe('stage 0 to 2');
    expect(stageRangeOf(300)).toBe('stage 3');
    expect(stageRangeOf(399)).toBe('stage 3');
    expect(stageRangeOf(410)).toBe('stage 4');
    expect(stageRangeOf(699)).toBe('stage 6');
    expect(stageRangeOf(700)).toBeNull();
  });

  it('gives every track of Stages 3 to 6 a range inside its stage, and no two tracks share a number', () => {
    const tracks = Object.entries(TRACK_RANGES);
    expect(tracks.length).toBeGreaterThanOrEqual(20);
    for (const [name, range] of tracks) {
      expect(range.start, name).toBeLessThanOrEqual(range.end);
      expect(stageRangeOf(range.start), name).toBe(stageRangeOf(range.end));
      expect(stageRangeOf(range.start), name).toBe(`stage ${name.slice(0, 1)}`);
    }
    const sorted = tracks.map(([, range]) => range).sort((a, b) => a.start - b.start);
    sorted.slice(1).forEach((range, i) => {
      expect(range.start, JSON.stringify(range)).toBeGreaterThan(sorted[i]?.end ?? 0);
    });
  });

  it('matches the Stage 3 ranges of the plan', () => {
    expect(TRACK_RANGES['3seam']).toMatchObject({ start: 300, end: 319 });
    expect(TRACK_RANGES['3a']).toMatchObject({ start: 320, end: 339 });
    expect(TRACK_RANGES['3b']).toMatchObject({ start: 340, end: 359 });
    expect(TRACK_RANGES['3c']).toMatchObject({ start: 360, end: 369 });
    expect(TRACK_RANGES['3d']).toMatchObject({ start: 370, end: 379 });
    expect(TRACK_RANGES['3e']).toMatchObject({ start: 390, end: 399 });
  });
});

describe('checkJournalFolder', () => {
  const GOOD = [
    { tag: '0034_encounter_links', when: 1000 },
    { tag: '0035_onboarding_state', when: 2000 },
    { tag: '0320_notifications_core', when: 3000 },
    { tag: '0340_online_booking_links', when: 4000 },
  ];

  it('accepts a journal whose stamps rise, whose tags are unique and in range, and whose files match', async () => {
    expect(await checkJournalFolder(await folderOf(GOOD))).toEqual([]);
  });

  it('fails on a stamp that does not rise: the migrator would skip it on an existing database', async () => {
    const dir = await folderOf([
      { tag: '0035_onboarding_state', when: 2000 },
      { tag: '0320_notifications_core', when: 5000 },
      { tag: '0340_online_booking_links', when: 4000 },
    ]);

    const problems = await checkJournalFolder(dir);

    expect(codes(problems)).toEqual(['non_monotonic_when']);
    expect(problems[0]?.message).toContain('0340_online_booking_links');
    expect(problems[0]?.message).toContain('db:restamp');
  });

  it('fails on a stamp equal to the one before it', async () => {
    const dir = await folderOf([
      { tag: '0035_onboarding_state', when: 2000 },
      { tag: '0320_notifications_core', when: 2000 },
    ]);

    expect(codes(await checkJournalFolder(dir))).toEqual(['non_monotonic_when']);
  });

  it('fails on a tag that appears twice, and on a prefix two tags share', async () => {
    const dir = await folderOf(GOOD);
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    journal.entries.push(
      { idx: 4, version: '7', when: 5000, tag: '0320_notifications_core', breakpoints: true },
      { idx: 5, version: '7', when: 6000, tag: '0340_other_table', breakpoints: true },
    );
    await writeFile(journalPath, JSON.stringify(journal, null, 2));

    const found = codes(await checkJournalFolder(dir));

    expect(found).toContain('duplicate_tag');
    expect(found).toContain('duplicate_prefix');
  });

  it('fails on a prefix outside every range: past Stage 6', async () => {
    const dir = await folderOf([
      { tag: '0035_onboarding_state', when: 2000 },
      { tag: '0700_too_far', when: 3000 },
      { tag: '1000_way_too_far', when: 4000 },
    ]);

    const problems = await checkJournalFolder(dir);

    expect(codes(problems)).toEqual(['out_of_range_prefix', 'out_of_range_prefix']);
    expect(problems.map((problem) => problem.tag)).toEqual(['0700_too_far', '1000_way_too_far']);
  });

  it('fails on a tag without the four digit number', async () => {
    const dir = await folderOf([{ tag: '0035_onboarding_state', when: 2000 }]);
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries.push({ tag: 'no_number_here' });
    await writeFile(journalPath, JSON.stringify(journal, null, 2));

    expect(codes(await checkJournalFolder(dir))).toContain('bad_tag');
  });

  it('fails on an entry without its file, a file without its entry and an entry without a snapshot', async () => {
    const dir = await folderOf(GOOD);
    await rm(join(dir, '0340_online_booking_links.sql'));
    await writeFile(join(dir, '0350_orphan.sql'), '-- orphan\n');
    await rm(join(dir, 'meta', '0320_snapshot.json'));

    const found = codes(await checkJournalFolder(dir));

    expect(found).toEqual(
      expect.arrayContaining(['missing_sql', 'orphan_sql', 'missing_snapshot']),
    );
  });

  it('fails on a snapshot chain with two children of one parent, which drizzle-kit refuses', async () => {
    const dir = await folderOf(GOOD);
    const path = join(dir, 'meta', '0340_snapshot.json');
    const snapshot = JSON.parse(await readFile(path, 'utf8')) as { prevId: string };
    // 0340 points at 0035 instead of 0320: the shape two tracks produce when each branches off 0035.
    snapshot.prevId = snapshotId('0035');
    await writeFile(path, JSON.stringify(snapshot, null, 2));

    const problems = await checkJournalFolder(dir);

    expect(codes(problems)).toEqual(['broken_snapshot_chain']);
    expect(problems[0]?.tag).toBe('0340_online_booking_links');
  });

  it('fails on idx values that are not 0, 1, 2 ...', async () => {
    const dir = await folderOf(GOOD);
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    const third = journal.entries[2];
    if (!third) throw new Error('fixture has no third entry');
    third.idx = 7;
    await writeFile(journalPath, JSON.stringify(journal, null, 2));

    expect(codes(await checkJournalFolder(dir))).toEqual(['bad_idx']);
  });
});
