import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkMigrationDrift } from './check-migration-drift.js';

const apiRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const migrationsDir = join(apiRoot, 'src/db/migrations');
// Inside the package so that the scratch schema can import drizzle-orm.
const scratchDir = join(apiRoot, 'node_modules/.cache/migration-drift-test');

let workDir: string;

beforeAll(async () => {
  await mkdir(scratchDir, { recursive: true });
  workDir = await mkdtemp(join(scratchDir, 'schema-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('checkMigrationDrift', () => {
  it('passes on the committed schema and migrations', async () => {
    const result = await checkMigrationDrift({
      schemaFile: join(apiRoot, 'src/db/schema/index.ts'),
      migrationsDir,
      scratchDir,
    });

    expect(result.missing).toEqual([]);
    expect(result.drift).toBe(false);
  }, 60_000);

  it('fails when the schema gains a table that has no migration', async () => {
    const schemaFile = join(workDir, 'edited-schema.ts');
    await writeFile(
      schemaFile,
      [
        "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
        '',
        "export const hand_edited = pgTable('hand_edited', { id: uuid('id').primaryKey() });",
        '',
      ].join('\n'),
    );

    const result = await checkMigrationDrift({ schemaFile, migrationsDir, scratchDir });

    expect(result.drift).toBe(true);
    expect(result.missing).toHaveLength(1);
  }, 60_000);
});
