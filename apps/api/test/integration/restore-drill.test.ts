import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runRestoreDrill } from '../../scripts/drill/drill.js';
import { drillPassed, formatReport } from '../../scripts/drill/report.js';
import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureDemoTenant, seedDemoTenant } from '../../src/db/seed/demo/index.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { sealTenant } from '../../src/platform/audit/sealer.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import {
  createOwnerDb,
  createRuntimeDb,
  createSealerDb,
  type DbHandle,
} from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';

/**
 * The restore drill of the platform (task 6.44, `pnpm drill:restore`), on throwaway containers: the
 * database holds the demonstration organization with its audit trail sealed, the backup goes to the
 * object store, is read back, restored into a scratch database, and the copy is checked row by row
 * and chain by chain. A database that was altered before the dump is caught by the chains, which no
 * checksum of the dump could do (the dump is faithful to what it was given).
 */
const DATABASE = 'consultorio_drill';
const ROLES_SQL = new URL('../../../../infra/postgres/init/01-roles.sql', import.meta.url);
const MINIO_IMAGE = 'bitnamilegacy/minio:2025.7.23-debian-12-r5';
const MINIO_USER = 'minio_test';
const MINIO_PASSWORD = 'minio_test_only_secret';
const LIVE_BUCKET = 'drill-live';
const STORE_BUCKET = 'drill-backups';
let scratchCount = 0;

let postgres: StartedPostgreSqlContainer;
let minio: StartedTestContainer;
let workDir: string;
let s3: S3Client;
let endpoint: string;

const urlFor = (database: string) =>
  `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${String(postgres.getPort())}/${database}`;
const roleUrl = (user: string, password: string) =>
  `postgres://${user}:${password}@${postgres.getHost()}:${String(postgres.getPort())}/${DATABASE}`;

const bucket = (name: string) => ({
  bucket: name,
  region: 'us-east-1',
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
});

/** One drill, with a scratch bucket of its own (a bucket kept by an earlier drill is not reused). */
async function drill(overrides: { keep?: boolean } = {}) {
  scratchCount += 1;
  const scratchBucket = `drill-scratch-${String(scratchCount)}`;
  const report = await runRestoreDrill({
    postgres: {
      container: postgres.getId(),
      database: DATABASE,
      user: postgres.getUsername(),
    },
    connectionUrl: urlFor,
    bucket: bucket(LIVE_BUCKET),
    store: bucket(STORE_BUCKET),
    scratchBucket,
    workDir,
    clock: () => new Date('2026-10-20T15:30:00Z'),
    ...overrides,
  });
  return { report, scratchBucket };
}

async function databaseExists(name: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    const found = await client.query('select 1 from pg_database where datname = $1', [name]);
    return found.rowCount === 1;
  } finally {
    await client.end();
  }
}

async function bucketExists(name: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: name }));
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  [postgres, minio] = await Promise.all([
    new PostgreSqlContainer('postgres:17').withDatabase(DATABASE).start(),
    new GenericContainer(MINIO_IMAGE)
      .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start(),
  ]);
  workDir = await mkdtemp(join(tmpdir(), 'restore-drill-'));
  endpoint = `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`;
  s3 = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
    maxAttempts: 5,
  });
  await s3.send(new CreateBucketCommand({ Bucket: LIVE_BUCKET }));
  await s3.send(
    new PutObjectCommand({
      Bucket: LIVE_BUCKET,
      Key: 't/0190a000-0000-7000-8000-0000000000aa/docs/one',
      Body: Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(512)]),
      ContentType: 'application/pdf',
    }),
  );

  const admin = new pg.Client({ connectionString: urlFor(DATABASE) });
  await admin.connect();
  try {
    await admin.query(await readFile(ROLES_SQL, 'utf8'));
  } finally {
    await admin.end();
  }
  await runMigrations(roleUrl('app_owner', 'app_owner_dev_only'));
  const owner = createOwnerDb(roleUrl('app_owner', 'app_owner_dev_only'));
  await seedPlatformCatalogs(owner.db);
  await owner.close();

  // The demonstration organization, with the whole story of the demo, and its trail sealed.
  const runtime: DbHandle = createRuntimeDb(roleUrl('app_rw', 'app_rw_dev_only'));
  const sealer = createSealerDb(roleUrl('audit_sealer', 'audit_sealer_dev_only'));
  try {
    const withTenant = createWithTenant(runtime.db);
    const tenant = await ensureDemoTenant(runtime.db, withTenant, 'drill');
    await seedDemoTenant(
      {
        withTenant,
        hasher: createPasswordHasher(),
        keys: createTenantKeys({
          kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
        }),
        consentText: { textKey: 'consent.data_processing', version: '1' },
        clock: () => new Date('2026-03-02T12:00:00Z'),
        documents: { storage: createMemoryObjectStorage(), scanner: createFakeScanner() },
      },
      tenant.id,
    );
    const sealerRun = createWithTenant(sealer.db);
    for (;;) {
      const sealed = await sealerRun({ tenantId: tenant.id, userId: tenant.id }, (tx) =>
        sealTenant(tx, { graceMs: 0 }),
      );
      if (sealed.sealed === 0) break;
    }
  } finally {
    await Promise.all([runtime.close(), sealer.close()]);
  }
}, 600_000);

afterAll(async () => {
  s3.destroy();
  await rm(workDir, { recursive: true, force: true });
  await Promise.all([postgres.stop(), minio.stop()]);
});

describe('the restore drill', () => {
  it('backs up to the store, restores from it into a scratch database and finds the copy faithful', async () => {
    const { report } = await drill();

    // Where asked, the report is kept: it is the evidence the runbook records.
    const evidence = process.env['DRILL_REPORT_FILE'];
    if (evidence) await writeFile(evidence, formatReport(report));
    expect(drillPassed(report), formatReport(report)).toBe(true);
    // Something real was compared: the tables, the rows and a trail with events in it.
    expect(report.counts.tables).toBeGreaterThan(100);
    expect(report.counts.rows).toBeGreaterThan(500);
    expect(report.chains.tenantsWithEvents).toBeGreaterThanOrEqual(1);
    expect(report.chains.eventsVerified).toBeGreaterThan(100);
    expect(report.backup.objects).toBe(1);
    expect(report.restore.objects).toBe(1);
    // The backup lived in the store under a prefix of its own and was read back from there.
    expect(report.store.bucket).toBe(STORE_BUCKET);
    expect(report.store.prefix).toBe('drill/backup-20261020T153000Z');
    const kept = await s3.send(
      new ListObjectsV2Command({ Bucket: STORE_BUCKET, Prefix: report.store.prefix }),
    );
    expect(kept.KeyCount).toBe(report.store.files);
    expect(report.store.files).toBeGreaterThanOrEqual(4);
  });

  it('leaves nothing behind: the scratch database and the scratch bucket are gone, the live ones untouched', async () => {
    const { report, scratchBucket } = await drill();

    expect(await databaseExists(report.restore.database)).toBe(false);
    expect(await bucketExists(scratchBucket)).toBe(false);
    expect(await databaseExists(DATABASE)).toBe(true);
    expect(await bucketExists(LIVE_BUCKET)).toBe(true);
  });

  it('keeps the scratch copy when asked to, so a person can look at it', async () => {
    const { report, scratchBucket } = await drill({ keep: true });

    expect(drillPassed(report)).toBe(true);
    expect(await databaseExists(report.restore.database)).toBe(true);
    expect(await bucketExists(scratchBucket)).toBe(true);
  });

  it('fails the chain check when the trail was altered before the dump, and says where', async () => {
    // The dump is faithful to what the database held: the checksums of the backup cannot tell. The
    // chains can. Altering a sealed event needs the privileges of nobody the application runs as.
    const admin = new pg.Client({ connectionString: urlFor(DATABASE) });
    await admin.connect();
    try {
      await admin.query('SET session_replication_role = replica');
      const target = await admin.query<{ tenant_id: string; seq: string }>(
        'select tenant_id, seq::text from audit_event where seq = 3 limit 1',
      );
      expect(target.rowCount).toBe(1);
      await admin.query(
        `update audit_event set outcome = case outcome when 'allow' then 'deny' else 'allow' end
          where tenant_id = $1 and seq = 3`,
        [target.rows[0]?.tenant_id],
      );
    } finally {
      await admin.end();
    }

    const { report } = await drill();

    expect(drillPassed(report)).toBe(false);
    expect(report.chains.breaks).toHaveLength(1);
    expect(report.chains.breaks[0]).toMatchObject({ firstBadSeq: 3, reason: 'hash_mismatch' });
    expect(report.chains.breaks[0]?.scope).toMatch(/^tenant /);
    // Row counts are fine: the copy IS the source. It is the chain that says it cannot be trusted.
    expect(report.counts.problems).toEqual([]);
    expect(formatReport(report)).toContain('FAILED');
  });
});
