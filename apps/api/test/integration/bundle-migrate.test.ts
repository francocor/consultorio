import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildBundle } from '../../scripts/build-bundle.js';

/**
 * The migrator inside the bundle: `node main.js migrate` applies every migration to an empty database
 * with nothing from the repository around it but the `node_modules` the bundle's dependencies come
 * from. This is what the desktop shell runs before the first start and after every update.
 */
const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_MIGRATIONS = join(API_ROOT, 'src', 'db', 'migrations');
/** Inside `node_modules` so the externals of the bundle resolve, and out of git's way. */
const SCRATCH = join(API_ROOT, 'node_modules', '.cache', 'bundle-test');

let bundle: string;
let cwd: string;

beforeAll(async () => {
  bundle = join(SCRATCH, randomUUID());
  cwd = await mkdtemp(join(tmpdir(), 'consulvia-bundle-cwd-'));
  await buildBundle({ outdir: bundle });
}, 120_000);

afterAll(async () => {
  await rm(bundle, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/** Runs the bundle the way the shell does: a child process, an environment, no arguments of ours. */
function runBundle(env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(bundle, 'main.js'), 'migrate'], {
      cwd,
      env: { PATH: process.env['PATH'] ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** An empty database owned by the migration login, as the shell leaves one after `initdb` and the roles. */
async function emptyDatabase(): Promise<string> {
  const name = `bundle_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER app_owner`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${name} TO app_rw, app_operator, audit_sealer, app_releaser`,
    );
    // The bootstrap of the cluster grants this membership once, and migration 0020 takes it away in
    // the first database it runs on: the cluster of a new install has it again.
    await admin.query(
      'GRANT audit_sealer TO app_rw WITH INHERIT FALSE, SET TRUE GRANTED BY app_owner',
    );
  } finally {
    await admin.end();
  }
  const url = new URL(inject('ownerUrl'));
  url.pathname = `/${name}`;
  return url.toString();
}

async function query<T extends pg.QueryResultRow>(url: string, text: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

const journalOf = async (folder: string) =>
  (
    JSON.parse(await readFile(join(folder, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    }
  ).entries.map((entry) => entry.tag);

describe('the bundle', () => {
  it('ships the SQL of every migration and the journal, and not the snapshots', async () => {
    const shipped = join(bundle, 'migrations');
    const tags = await journalOf(SOURCE_MIGRATIONS);

    expect(await journalOf(shipped)).toEqual(tags);
    const files = (await readdir(shipped)).filter((name) => name.endsWith('.sql')).sort();
    expect(files).toEqual(tags.map((tag) => `${tag}.sql`).sort());
    expect(await readdir(join(shipped, 'meta'))).toEqual(['_journal.json']);
  });

  it('applies every migration to an empty database, and loads the catalogs', async () => {
    const url = await emptyDatabase();

    const result = await runBundle({ MIGRATION_DATABASE_URL: url });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('migrations applied');
    expect(result.stdout).toContain('platform catalogs loaded');
    const applied = await query<{ n: number }>(
      url,
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(applied[0]?.n).toBe((await journalOf(SOURCE_MIGRATIONS)).length);
    const payers = await query<{ n: number }>(url, 'select count(*)::int as n from payer');
    expect(payers[0]?.n).toBeGreaterThan(0);
    const roles = await query<{ relrowsecurity: boolean }>(
      url,
      "select relrowsecurity from pg_class where relname = 'patient'",
    );
    expect(roles[0]?.relrowsecurity).toBe(true);
  }, 120_000);

  it('can run again on the same database and applies nothing twice', async () => {
    const url = await emptyDatabase();
    await runBundle({ MIGRATION_DATABASE_URL: url });

    const again = await runBundle({ MIGRATION_DATABASE_URL: url });

    expect(again.code).toBe(0);
    const applied = await query<{ n: number }>(
      url,
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(applied[0]?.n).toBe((await journalOf(SOURCE_MIGRATIONS)).length);
  }, 120_000);

  it('reads the migrations from MIGRATIONS_DIR when it is set', async () => {
    const url = await emptyDatabase();
    const moved = join(cwd, 'elsewhere');
    await cp(join(bundle, 'migrations'), moved, { recursive: true });
    await rm(join(bundle, 'migrations'), { recursive: true, force: true });

    const withDir = await runBundle({ MIGRATION_DATABASE_URL: url, MIGRATIONS_DIR: moved });
    const without = await runBundle({ MIGRATION_DATABASE_URL: url });
    await cp(moved, join(bundle, 'migrations'), { recursive: true });

    expect(withDir.code).toBe(0);
    expect(without.code).toBe(3);
    expect(without.stderr).toContain('MIGRATIONS_DIR');
  }, 120_000);

  it('exits 3 without a database to migrate', async () => {
    const result = await runBundle({});

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('MIGRATION_DATABASE_URL');
  });
});
