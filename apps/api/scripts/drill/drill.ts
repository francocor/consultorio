import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { verifyPlatformChain } from '../../src/platform/audit/platform-audit.js';
import { verifyTenantChain, type VerifyResult } from '../../src/platform/audit/verify.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import {
  createBackup,
  restoreBackup,
  verifyBackup,
  type BucketTarget,
  type Logger,
  type PostgresTarget,
} from '../backup/backup.js';

import { findCountProblems, type RowCounts } from './counts.js';
import type { ChainBreak, DrillReport } from './report.js';
import { downloadFolder, removeBucket, uploadFolder } from './store.js';

/**
 * The restore drill of the local environment (task 6.44, `pnpm drill:restore`; the production runbook
 * is `docs/runbooks/backup-restore.md`): take a backup of the running database and bucket, keep it in
 * the object store, read it back, restore it into a scratch database and a scratch bucket, and prove the
 * copy is faithful in two ways a checksum cannot. Every table has the rows the source had, and the
 * chain of audit events of every organization (and of the platform) verifies from its first event: a
 * trail that was altered before the dump is a faithful dump of an altered trail.
 *
 * The scratch copy is dropped at the end, unless asked to keep it. Nothing the drill does touches the
 * live database or the live bucket beyond reading them.
 */

export interface RestoreDrillOptions {
  /** The container that runs Postgres (for `pg_dump` and `pg_restore`) and the database to back up. */
  postgres: PostgresTarget;
  /** A connection string, as a superuser, to a database of the cluster. */
  connectionUrl: (database: string) => string;
  /** The live document bucket. */
  bucket: BucketTarget;
  /** The bucket the backups are kept in (created when missing). */
  store: BucketTarget;
  /** The bucket the restore fills; it must be new or empty, and it is removed at the end. */
  scratchBucket: string;
  /** A folder for the working copies; the drill makes its own inside it and removes it. */
  workDir: string;
  clock?: () => Date;
  log?: Logger;
  /** Keep the scratch database and bucket so a person can open them. */
  keep?: boolean;
}

/** Rows per table of the `public` schema (partitions are counted through their parent). */
export async function countRows(connectionString: string): Promise<RowCounts> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const tables = await client.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname`,
    );
    const counts: Record<string, number> = {};
    for (const { name } of tables.rows) {
      const result = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public."${name.replaceAll('"', '""')}"`,
      );
      counts[name] = Number(result.rows[0]?.n ?? 0);
    }
    return counts;
  } finally {
    await client.end();
  }
}

export interface ChainsFound {
  tenants: number;
  tenantsWithEvents: number;
  eventsVerified: number;
  platformEventsVerified: number;
  breaks: ChainBreak[];
}

/**
 * Walks the chain of every organization and the platform's from the first event. It connects as a
 * superuser (the copy is a scratch database), so row level security does not hide an organization.
 */
export async function verifyChains(connectionString: string): Promise<ChainsFound> {
  const pool = new pg.Pool({ connectionString, max: 2 });
  const db = drizzle(pool);
  const found: ChainsFound = {
    tenants: 0,
    tenantsWithEvents: 0,
    eventsVerified: 0,
    platformEventsVerified: 0,
    breaks: [],
  };
  const record = (scope: string, result: VerifyResult, platform: boolean) => {
    if (platform) found.platformEventsVerified += result.verified;
    else {
      found.eventsVerified += result.verified;
      if (result.verified > 0) found.tenantsWithEvents += 1;
    }
    if (!result.ok) {
      found.breaks.push({ scope, firstBadSeq: result.firstBadSeq, reason: result.reason });
    }
  };
  try {
    const tenants = await pool.query<{ id: string }>('SELECT id FROM tenant ORDER BY id');
    found.tenants = tenants.rows.length;
    for (const { id } of tenants.rows) {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${id}, true)`);
        return verifyTenantChain(tx as unknown as Tx);
      });
      record(`tenant ${id}`, result, false);
    }
    const platform = await db.transaction((tx) => verifyPlatformChain(tx as unknown as Tx));
    record('platform', platform, true);
  } finally {
    await pool.end();
  }
  return found;
}

const stampOf = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
    .toLowerCase();

export async function runRestoreDrill(options: RestoreDrillOptions): Promise<DrillReport> {
  const log = options.log ?? (() => undefined);
  const clock = options.clock ?? (() => new Date());
  const started = clock();
  const startedAt = Date.now();
  await mkdir(options.workDir, { recursive: true });
  const work = await mkdtemp(join(options.workDir, 'drill-'));
  const sourceUrl = options.connectionUrl(options.postgres.database);
  const scratchDatabase = `drill_${stampOf(started)}_${randomBytes(3).toString('hex')}`;
  const scratchTarget: BucketTarget = { ...options.bucket, bucket: options.scratchBucket };
  let restoredAny = false;

  try {
    log('counting the rows of the source');
    const before = await countRows(sourceUrl);

    const { dir, manifest } = await createBackup({
      postgres: options.postgres,
      bucket: options.bucket,
      outDir: work,
      clock,
      log,
    });
    // The source moves while it is dumped: the count after tells how far.
    const after = await countRows(sourceUrl);

    log('keeping the backup in the store');
    const prefix = `drill/${basename(dir)}`;
    const keys = await uploadFolder(options.store, dir, prefix);

    log('reading the backup back from the store');
    const fetched = join(work, 'fetched', basename(dir));
    const files = await downloadFolder(options.store, prefix, fetched);
    if (files !== keys.length) {
      throw new Error(
        `the store gave back ${String(files)} files of the ${String(keys.length)} it was given`,
      );
    }
    await verifyBackup(fetched);

    log('restoring into a scratch database');
    const restoredInto = await restoreBackup({
      dir: fetched,
      postgres: options.postgres,
      intoDatabase: scratchDatabase,
      bucket: scratchTarget,
      log,
    });
    restoredAny = true;

    const copyUrl = options.connectionUrl(scratchDatabase);
    log('counting the rows of the copy');
    const restored = await countRows(copyUrl);
    log('verifying the chains of audit events of the copy');
    const chains = await verifyChains(copyUrl);

    return {
      startedAt: started.toISOString(),
      durationMs: Date.now() - startedAt,
      backup: {
        folder: basename(dir),
        databaseBytes: manifest.database.bytes,
        objects: manifest.objects.count,
      },
      store: { bucket: options.store.bucket, prefix, files },
      restore: {
        database: restoredInto.database,
        tables: restoredInto.tables,
        objects: restoredInto.objects,
      },
      counts: {
        tables: Object.keys(restored).length,
        rows: Object.values(restored).reduce((sum, rows) => sum + rows, 0),
        problems: findCountProblems(before, after, restored),
      },
      chains,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
    if (!options.keep) {
      if (restoredAny) await dropDatabase(options, scratchDatabase);
      await removeBucket(scratchTarget);
    }
  }
}

async function dropDatabase(options: RestoreDrillOptions, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: options.connectionUrl('postgres') });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}
