import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBackup, restoreBackup, type BucketTarget } from '../../scripts/backup/backup.js';
import { BackupCorrupt, verifyBackup } from '../../scripts/backup/manifest.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createTestPatient } from '../support/patients.js';
import { createTestTenant, visibleRows } from '../support/tenants.js';

/**
 * The restore drill (production runbook, "Quarterly restore drill"), on throwaway containers: take
 * a backup of a database and a bucket that hold real data, restore it into a NEW database and a NEW
 * bucket, and prove the copy is faithful, still isolates organizations and refuses to overwrite.
 * Needs Docker, like the rest of the integration suite.
 */
const DATABASE = 'consultorio_backup';
const ROLES_SQL = new URL('../../../../infra/postgres/init/01-roles.sql', import.meta.url);
const MINIO_IMAGE = 'bitnamilegacy/minio:2025.7.23-debian-12-r5';
const MINIO_USER = 'minio_test';
const MINIO_PASSWORD = 'minio_test_only_secret';
const SOURCE_BUCKET = 'drill-source';
const RESTORE_BUCKET = 'drill-restored';

let postgres: StartedPostgreSqlContainer;
let minio: StartedTestContainer;
let runtime: DbHandle;
let workDir: string;
let source: BucketTarget;
let target: BucketTarget;
let tenantA: string;
let tenantB: string;
let pdf: Buffer;

const superuserUrl = (database: string) =>
  `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${String(postgres.getPort())}/${database}`;
const roleUrl = (user: string, password: string, database: string) =>
  `postgres://${user}:${password}@${postgres.getHost()}:${String(postgres.getPort())}/${database}`;

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
  workDir = await mkdtemp(join(tmpdir(), 'backup-drill-'));

  const admin = new pg.Client({ connectionString: superuserUrl(DATABASE) });
  await admin.connect();
  try {
    await admin.query(await readFile(ROLES_SQL, 'utf8'));
  } finally {
    await admin.end();
  }
  await runMigrations(roleUrl('app_owner', 'app_owner_dev_only', DATABASE));
  runtime = createRuntimeDb(roleUrl('app_rw', 'app_rw_dev_only', DATABASE));

  // Two organizations with patients, so isolation can be checked on the restored copy.
  tenantA = (await createTestTenant(runtime, { slug: 'drill-a' })).id;
  tenantB = (await createTestTenant(runtime, { slug: 'drill-b' })).id;
  await createTestPatient(runtime, tenantA, { familyName: 'Gomez' });
  await createTestPatient(runtime, tenantA, { familyName: 'Rios' });
  await createTestPatient(runtime, tenantB, { familyName: 'Soto' });

  const endpoint = `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`;
  const credentials = { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD };
  source = {
    bucket: SOURCE_BUCKET,
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials,
  };
  target = { ...source, bucket: RESTORE_BUCKET };
  pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(2048), Buffer.from('\n%%EOF\n')]);
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials,
    maxAttempts: 5,
  });
  await s3.send(new CreateBucketCommand({ Bucket: SOURCE_BUCKET }));
  await s3.send(
    new PutObjectCommand({
      Bucket: SOURCE_BUCKET,
      Key: `t/${tenantA}/docs/0190a000-0000-7000-8000-0000000000d1`,
      Body: pdf,
      ContentType: 'application/pdf',
    }),
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: SOURCE_BUCKET,
      Key: `t/${tenantB}/docs/0190a000-0000-7000-8000-0000000000d2`,
      Body: Buffer.from('another organization file'),
      ContentType: 'text/plain',
    }),
  );
  s3.destroy();
}, 240_000);

afterAll(async () => {
  await runtime.close();
  await rm(workDir, { recursive: true, force: true });
  await Promise.all([postgres.stop(), minio.stop()]);
});

const postgresTarget = () => ({
  container: postgres.getId(),
  database: DATABASE,
  user: postgres.getUsername(),
});

describe('the restore drill', () => {
  it('backs up the database and the bucket, and restores them into new ones, faithfully', async () => {
    const { dir, manifest } = await createBackup({
      postgres: postgresTarget(),
      bucket: source,
      outDir: workDir,
      clock: () => new Date('2026-10-17T15:30:00Z'),
    });

    expect(dir).toMatch(/backup-20261017T153000Z$/);
    expect(manifest.objects.count).toBe(2);
    expect(manifest.database.bytes).toBeGreaterThan(10_000);
    await expect(verifyBackup(dir)).resolves.toMatchObject({ version: 1 });

    const report = await restoreBackup({
      dir,
      postgres: postgresTarget(),
      intoDatabase: 'consultorio_restored',
      bucket: target,
    });
    expect(report.objects).toBe(2);
    expect(report.tables).toBeGreaterThan(30);

    // The data is there, and each organization still sees only its own (row level security came
    // across with the dump, with FORCE on the tables).
    const restored = createRuntimeDb(roleUrl('app_rw', 'app_rw_dev_only', 'consultorio_restored'));
    try {
      expect(await visibleRows(restored, tenantA, 'patient')).toBe(2);
      expect(await visibleRows(restored, tenantB, 'patient')).toBe(1);
    } finally {
      await restored.close();
    }
    const owner = new pg.Client({
      connectionString: roleUrl('app_owner', 'app_owner_dev_only', 'consultorio_restored'),
    });
    await owner.connect();
    try {
      const catalog = async (client: pg.Client) =>
        (
          await client.query<{ forced: number; policies: number }>(
            `SELECT (SELECT count(*) FROM pg_class WHERE relforcerowsecurity)::int AS forced,
                    (SELECT count(*) FROM pg_policies)::int AS policies`,
          )
        ).rows[0];
      const live = new pg.Client({
        connectionString: roleUrl('app_owner', 'app_owner_dev_only', DATABASE),
      });
      await live.connect();
      try {
        expect(await catalog(owner)).toEqual(await catalog(live));
        expect((await catalog(owner))?.forced).toBeGreaterThan(20);
      } finally {
        await live.end();
      }
    } finally {
      await owner.end();
    }

    // The documents are byte for byte the same, with their type.
    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint: target.endpoint,
      forcePathStyle: true,
      credentials: target.credentials,
      maxAttempts: 5,
    });
    try {
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: RESTORE_BUCKET,
          Key: `t/${tenantA}/docs/0190a000-0000-7000-8000-0000000000d1`,
        }),
      );
      const body = await object.Body?.transformToByteArray();
      expect(Buffer.from(body ?? []).equals(pdf)).toBe(true);
      expect(object.ContentType).toBe('application/pdf');
    } finally {
      s3.destroy();
    }
  }, 180_000);

  it('never restores over a database that exists', async () => {
    const { dir } = await createBackup({
      postgres: postgresTarget(),
      bucket: source,
      outDir: workDir,
      clock: () => new Date('2026-10-17T15:31:00Z'),
    });

    await expect(
      restoreBackup({ dir, postgres: postgresTarget(), intoDatabase: DATABASE, bucket: target }),
    ).rejects.toThrow(/already exists/);
    // The live database is untouched.
    expect(await visibleRows(runtime, tenantA, 'patient')).toBe(2);
  }, 120_000);

  it('never restores into the bucket the backup was taken from, or into one that already holds objects (JD-S2 S4)', async () => {
    const { dir } = await createBackup({
      postgres: postgresTarget(),
      bucket: source,
      outDir: workDir,
      clock: () => new Date('2026-10-17T15:31:30Z'),
    });
    const databaseExists = async (name: string) => {
      const admin = new pg.Client({ connectionString: superuserUrl(DATABASE) });
      await admin.connect();
      try {
        const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        return found.rowCount === 1;
      } finally {
        await admin.end();
      }
    };
    const liveObjects = async () => {
      const s3 = new S3Client({
        region: 'us-east-1',
        endpoint: source.endpoint,
        forcePathStyle: true,
        credentials: source.credentials,
        maxAttempts: 5,
      });
      try {
        return (await s3.send(new ListObjectsV2Command({ Bucket: SOURCE_BUCKET }))).KeyCount;
      } finally {
        s3.destroy();
      }
    };
    const before = await liveObjects();

    // The live bucket, under any name that is the same bucket.
    await expect(
      restoreBackup({
        dir,
        postgres: postgresTarget(),
        intoDatabase: 'consultorio_into_live',
        bucket: source,
      }),
    ).rejects.toThrow(/live bucket|taken from/);
    // A bucket that already has objects (the one the first drill filled).
    await expect(
      restoreBackup({
        dir,
        postgres: postgresTarget(),
        intoDatabase: 'consultorio_into_full',
        bucket: target,
      }),
    ).rejects.toThrow(/not empty/);

    // Nothing was created or written.
    expect(await databaseExists('consultorio_into_live')).toBe(false);
    expect(await databaseExists('consultorio_into_full')).toBe(false);
    expect(await liveObjects()).toBe(before);
  }, 120_000);

  it('refuses to restore a backup that was changed after it was taken, before creating anything', async () => {
    const { dir } = await createBackup({
      postgres: postgresTarget(),
      bucket: source,
      outDir: workDir,
      clock: () => new Date('2026-10-17T15:32:00Z'),
    });
    const dump = join(dir, 'database.dump');
    await writeFile(dump, Buffer.concat([await readFile(dump), Buffer.from('tampered')]));

    await expect(
      restoreBackup({
        dir,
        postgres: postgresTarget(),
        intoDatabase: 'consultorio_tampered',
        bucket: target,
      }),
    ).rejects.toThrow(BackupCorrupt);
    const admin = new pg.Client({ connectionString: superuserUrl(DATABASE) });
    await admin.connect();
    try {
      const found = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname = 'consultorio_tampered'",
      );
      expect(found.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  }, 120_000);
});
