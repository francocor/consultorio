import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeMigrationsFolder, snapshotId } from './migration-folder.js';
import { checkJournalFolder, readFolder } from './migration-journal.js';
import { createMigration, nextMigrationNumber } from './new-migration.js';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function folderOf(entries: { tag: string; when: number }[]): Promise<string> {
  const dir = await makeMigrationsFolder(entries);
  folders.push(dir);
  return dir;
}

const BASE = [
  { tag: '0034_encounter_links', when: 1000 },
  { tag: '0035_onboarding_state', when: 2000 },
];

describe('nextMigrationNumber', () => {
  const journal = async (entries: { tag: string; when: number }[]) =>
    (await readFolder(await folderOf(entries))).journal;

  it('starts a track at the first number of its range', async () => {
    expect(nextMigrationNumber(await journal(BASE), '3a')).toBe(320);
    expect(nextMigrationNumber(await journal(BASE), '3b')).toBe(340);
    expect(nextMigrationNumber(await journal(BASE), '3seam')).toBe(300);
  });

  it('continues after the highest number the track already used', async () => {
    const used = await journal([
      ...BASE,
      { tag: '0320_notifications_core', when: 3000 },
      { tag: '0322_local_whatsapp', when: 4000 },
    ]);

    expect(nextMigrationNumber(used, '3a')).toBe(323);
    expect(nextMigrationNumber(used, '3b')).toBe(340);
  });

  it('takes the number a task names when it is inside the range and free', async () => {
    const used = await journal([...BASE, { tag: '0320_notifications_core', when: 3000 }]);

    expect(nextMigrationNumber(used, '3a', 323)).toBe(323);
    expect(() => nextMigrationNumber(used, '3a', 320)).toThrow(/already used/);
    expect(() => nextMigrationNumber(used, '3a', 340)).toThrow(/outside the range/);
  });

  it('refuses an unknown track and a range that is full', async () => {
    expect(() =>
      nextMigrationNumber({ version: '7', dialect: 'postgresql', entries: [] }, '9z'),
    ).toThrow(/unknown track/i);
    const full = await journal([
      ...BASE,
      ...Array.from({ length: 10 }, (_, i) => ({
        tag: `${String(390 + i).padStart(4, '0')}_filler_${String(i)}`,
        when: 3000 + i,
      })),
    ]);

    expect(() => nextMigrationNumber(full, '3e')).toThrow(/full/);
  });
});

describe('createMigration (a custom migration in the range of a track)', () => {
  it('writes the file, the journal entry and a snapshot that continues the last one', async () => {
    const dir = await folderOf(BASE);

    const created = await createMigration({
      migrationsDir: dir,
      track: '3a',
      name: 'notifications_core',
      now: new Date(5000),
    });

    expect(created.tag).toBe('0320_notifications_core');
    expect(await readFile(join(dir, '0320_notifications_core.sql'), 'utf8')).toMatch(
      /Custom SQL migration[\s\S]*Stage 3, A messaging/,
    );
    const { journal, snapshots } = await readFolder(dir);
    expect(journal.entries.at(-1)).toEqual({
      idx: 2,
      version: '7',
      when: 5000,
      tag: '0320_notifications_core',
      breakpoints: true,
    });
    expect(snapshots.get('0320')?.prevId).toBe(snapshotId('0035'));
    expect(snapshots.get('0320')?.id).not.toBe(snapshotId('0035'));
    expect(await checkJournalFolder(dir)).toEqual([]);
  });

  it('stamps the entry later than every entry of the journal, even when the clock is behind', async () => {
    const dir = await folderOf([
      ...BASE,
      { tag: '0320_notifications_core', when: 9_000_000_000_000 },
    ]);

    await createMigration({
      migrationsDir: dir,
      track: '3b',
      name: 'online_booking_links',
      now: new Date(1_000),
    });

    const { journal } = await readFolder(dir);
    expect(journal.entries.at(-1)?.when).toBe(9_000_000_000_001);
    expect(await checkJournalFolder(dir)).toEqual([]);
  });

  it('keeps the numbers of the track when it asks for one, in the order the plan gives them', async () => {
    const dir = await folderOf(BASE);

    await createMigration({
      migrationsDir: dir,
      track: '3a',
      name: 'local_whatsapp',
      number: 322,
      now: new Date(5000),
    });
    await createMigration({
      migrationsDir: dir,
      track: '3a',
      name: 'channel_preference',
      number: 321,
      now: new Date(6000),
    });

    const { journal } = await readFolder(dir);
    // The journal order is the order they were created (and will be merged), not the number order.
    expect(journal.entries.map((entry) => entry.tag).slice(-2)).toEqual([
      '0322_local_whatsapp',
      '0321_channel_preference',
    ]);
    expect(await checkJournalFolder(dir)).toEqual([]);
  });

  it('refuses a name that is not lowercase words, and never writes anything then', async () => {
    const dir = await folderOf(BASE);

    for (const name of ['', 'Notifications', 'with-dash', 'two words', '../escape']) {
      await expect(
        createMigration({ migrationsDir: dir, track: '3a', name, now: new Date(5000) }),
        name,
      ).rejects.toThrow(/name/);
    }
    expect((await readFolder(dir)).journal.entries).toHaveLength(2);
  });

  it('carries SQL it was given instead of the empty custom file', async () => {
    const dir = await folderOf(BASE);

    await createMigration({
      migrationsDir: dir,
      track: '3b',
      name: 'online_booking_links',
      now: new Date(5000),
      sql: 'CREATE TABLE "booking_link" ("id" uuid PRIMARY KEY);\n',
    });

    expect(await readFile(join(dir, '0340_online_booking_links.sql'), 'utf8')).toBe(
      'CREATE TABLE "booking_link" ("id" uuid PRIMARY KEY);\n',
    );
  });
});
