import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { ensureBucket } from './bucket.js';
import {
  BackupCorrupt,
  MANIFEST_FILE,
  OBJECTS_DIR,
  readBackup,
  sha256OfFile,
  verifyBackup,
  type BackupManifest,
  type ObjectIndexEntry,
} from './manifest.js';
import { withTransientRetry } from './retry.js';

/**
 * Backup and restore of the local environment: the Postgres database (a custom-format `pg_dump`)
 * and the document bucket (every object, with a checksum). It is the local counterpart of the
 * production runbook (`docs/runbooks/backup-restore.md`): the same drill, on a laptop.
 *
 * Postgres tools run INSIDE the database container (`docker exec`), so the host needs nothing but
 * Docker; the bucket is read and written through the S3 API, so it works with MinIO and with S3.
 */

export interface PostgresTarget {
  /** Container (name or id) that runs Postgres and has `pg_dump`, `pg_restore` and `psql`. */
  container: string;
  database: string;
  /** A superuser of the cluster; the local container trusts its own socket. */
  user: string;
}

export interface BucketTarget {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export type Logger = (line: string) => void;

interface Exec {
  code: number;
  stderr: string;
  stdout: string;
}

/** Runs `docker exec` in the container, streaming a file in (`stdin`) or out (`stdout`) when asked. */
function dockerExec(
  container: string,
  command: readonly string[],
  io: { stdin?: string; stdout?: string } = {},
): Promise<Exec> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, ...command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const done: Promise<void>[] = [];
    if (io.stdout) {
      done.push(pipeline(child.stdout, createWriteStream(io.stdout)));
    } else {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
    }
    if (io.stdin) {
      done.push(pipeline(createReadStream(io.stdin), child.stdin));
    } else {
      child.stdin.end();
    }
    child.on('error', reject);
    child.on('close', (code) => {
      Promise.all(done).then(
        () => {
          resolve({ code: code ?? 1, stderr, stdout });
        },
        (error: unknown) => {
          reject(error instanceof Error ? error : new Error('stream failed'));
        },
      );
    });
  });
}

async function psql(target: PostgresTarget, database: string, sql: string): Promise<string> {
  const result = await dockerExec(target.container, [
    'psql',
    '-U',
    target.user,
    '-d',
    database,
    '-X',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);
  if (result.code !== 0) throw new Error(`psql failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function s3Client(target: BucketTarget): S3Client {
  return new S3Client({
    region: target.region,
    ...(target.endpoint === undefined ? {} : { endpoint: target.endpoint }),
    ...(target.forcePathStyle === undefined ? {} : { forcePathStyle: target.forcePathStyle }),
    ...(target.credentials === undefined ? {} : { credentials: target.credentials }),
  });
}

// eslint-disable-next-line no-control-regex
const UNSAFE_SEGMENT = /[\\:*?"<>|\u0000-\u001f]/;

/** Keys that cannot be written as a file inside the backup directory are refused, not rewritten. */
function assertSafeKey(key: string): void {
  const segments = key.split('/');
  if (
    key.startsWith('/') ||
    segments.some(
      (part) => part === '' || part === '.' || part === '..' || UNSAFE_SEGMENT.test(part),
    )
  ) {
    throw new BackupCorrupt(`an object key cannot be stored in a backup directory: ${key}`);
  }
}

async function copyObjects(
  source: BucketTarget,
  dir: string,
  log: Logger,
): Promise<ObjectIndexEntry[]> {
  const client = s3Client(source);
  const index: ObjectIndexEntry[] = [];
  try {
    let token: string | undefined;
    do {
      // Every call to the store is asked again when the connection is reset under load (CI PR #17).
      const page = await withTransientRetry(() =>
        client.send(new ListObjectsV2Command({ Bucket: source.bucket, ContinuationToken: token })),
      );
      for (const item of page.Contents ?? []) {
        const key = item.Key;
        if (key === undefined) continue;
        assertSafeKey(key);
        const path = join(dir, OBJECTS_DIR, ...key.split('/'));
        await mkdir(dirname(path), { recursive: true });
        // The request and the stream are one unit: a connection reset while the body is read starts the
        // object again, with a new hash and a file written from the beginning.
        index.push(
          await withTransientRetry(async () => {
            const object = await client.send(
              new GetObjectCommand({ Bucket: source.bucket, Key: key }),
            );
            const hash = createHash('sha256');
            const body = object.Body as NodeJS.ReadableStream | undefined;
            if (!body) throw new Error(`object ${key} has no body`);
            body.on('data', (chunk: Buffer) => hash.update(chunk));
            await pipeline(body, createWriteStream(path));
            return {
              key,
              size: (await stat(path)).size,
              sha256: hash.digest('hex'),
              contentType: object.ContentType ?? 'application/octet-stream',
            };
          }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } finally {
    client.destroy();
  }
  log(`copied ${String(index.length)} objects`);
  return index;
}

export interface BackupOptions {
  postgres: PostgresTarget;
  bucket: BucketTarget;
  /** Directory that will hold the backup folder. */
  outDir: string;
  clock?: () => Date;
  log?: Logger;
}

/** `20261017T153000Z`, safe in a file name on every system. */
function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * Takes a backup. The copy is made in a work folder and renamed to its final name only when it is
 * complete (dump, objects, manifest), so a crash never leaves something that looks like a backup.
 */
export async function createBackup(
  options: BackupOptions,
): Promise<{ dir: string; manifest: BackupManifest }> {
  const log = options.log ?? (() => undefined);
  const now = (options.clock ?? (() => new Date()))();
  const name = `backup-${stamp(now)}`;
  const finalDir = join(options.outDir, name);
  const workDir = join(options.outDir, `${name}.partial`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    log('dumping the database');
    const dumpPath = join(workDir, 'database.dump');
    const dump = await dockerExec(
      options.postgres.container,
      ['pg_dump', '-U', options.postgres.user, '-d', options.postgres.database, '-Fc'],
      { stdout: dumpPath },
    );
    if (dump.code !== 0) throw new Error(`pg_dump failed: ${dump.stderr.trim()}`);
    const serverVersion = await psql(
      options.postgres,
      options.postgres.database,
      'SHOW server_version',
    );

    log('copying the document bucket');
    const index = await copyObjects(options.bucket, workDir, log);
    await writeFile(join(workDir, 'objects.json'), JSON.stringify(index, null, 2));

    const manifest: BackupManifest = {
      version: 1,
      createdAt: now.toISOString(),
      database: {
        name: options.postgres.database,
        dumpFile: 'database.dump',
        format: 'custom',
        sha256: await sha256OfFile(dumpPath),
        bytes: (await stat(dumpPath)).size,
        serverVersion,
      },
      objects: {
        bucket: options.bucket.bucket,
        indexFile: 'objects.json',
        count: index.length,
        bytes: index.reduce((sum, entry) => sum + entry.size, 0),
      },
    };
    await writeFile(join(workDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    await rename(workDir, finalDir);
    log(`backup ready: ${finalDir}`);
    return { dir: finalDir, manifest };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

/** A restore fills a bucket that is new or empty; it never mixes its objects with existing ones. */
export async function assertBucketEmpty(
  target: BucketTarget,
  createClient: (target: BucketTarget) => S3Client = s3Client,
): Promise<void> {
  const client = createClient(target);
  try {
    // The store may reset a connection under load; that says nothing about the bucket, so ask again
    // (a few times). Any other error still stops the restore: the guard never assumes "empty".
    const page = await withTransientRetry(() =>
      client.send(new ListObjectsV2Command({ Bucket: target.bucket, MaxKeys: 1 })),
    );
    if ((page.KeyCount ?? 0) > 0) {
      throw new Error(`the target bucket ${target.bucket} is not empty: restore into a new bucket`);
    }
  } catch (error) {
    // A bucket that does not exist yet is created by the restore.
    if ((error as { name?: string }).name !== 'NoSuchBucket') throw error;
  } finally {
    client.destroy();
  }
}

export interface RestoreOptions {
  dir: string;
  postgres: PostgresTarget;
  /**
   * The database to create and fill. It must NOT exist: a restore never overwrites a database, so
   * a mistaken command cannot destroy the live one. Compare, then switch the application over.
   */
  intoDatabase: string;
  bucket: BucketTarget;
  log?: Logger;
}

export interface RestoreReport {
  database: string;
  tables: number;
  objects: number;
}

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Restores a verified backup into a NEW database and a bucket (created when missing). The dump is
 * checked against its checksum first, every object is checked before it is uploaded, and the
 * roles of the cluster must already exist (`infra/postgres/init/01-roles.sql`).
 */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreReport> {
  const log = options.log ?? (() => undefined);
  if (!DATABASE_NAME.test(options.intoDatabase)) {
    throw new Error('the target database name must be lower-case letters, digits and underscores');
  }
  log('verifying the backup');
  const manifest = await verifyBackup(options.dir);
  const { index } = await readBackup(options.dir);
  // The bucket the backup was taken from is the live one: a restore writes into a different one.
  if (options.bucket.bucket === manifest.objects.bucket) {
    throw new Error(
      `the target bucket ${options.bucket.bucket} is the one the backup was taken from (the live bucket): restore into a new bucket`,
    );
  }

  const exists = await psql(
    options.postgres,
    'postgres',
    `SELECT count(*) FROM pg_database WHERE datname = '${options.intoDatabase}'`,
  );
  if (exists !== '0') {
    throw new Error(
      `the database ${options.intoDatabase} already exists: restore into a new name, never over a live database`,
    );
  }
  await assertBucketEmpty(options.bucket);
  log(`creating ${options.intoDatabase}`);
  await psql(options.postgres, 'postgres', `CREATE DATABASE ${options.intoDatabase}`);
  try {
    log('restoring the database');
    const restored = await dockerExec(
      options.postgres.container,
      [
        'pg_restore',
        '-U',
        options.postgres.user,
        '-d',
        options.intoDatabase,
        '--exit-on-error',
        '--no-comments',
      ],
      { stdin: join(options.dir, manifest.database.dumpFile) },
    );
    if (restored.code !== 0) throw new Error(`pg_restore failed: ${restored.stderr.trim()}`);
  } catch (error) {
    await psql(options.postgres, 'postgres', `DROP DATABASE IF EXISTS ${options.intoDatabase}`);
    throw error;
  }
  const tables = Number(
    await psql(
      options.postgres,
      options.intoDatabase,
      "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'",
    ),
  );

  log('restoring the document bucket');
  const client = s3Client(options.bucket);
  try {
    await ensureBucket(client, options.bucket.bucket);
    for (const entry of index) {
      assertSafeKey(entry.key);
      const body = await readFile(join(options.dir, OBJECTS_DIR, ...entry.key.split('/')));
      // A put of the same key with the same body is idempotent, so asking again is safe.
      await withTransientRetry(() =>
        client.send(
          new PutObjectCommand({
            Bucket: options.bucket.bucket,
            Key: entry.key,
            Body: body,
            ContentType: entry.contentType,
          }),
        ),
      );
    }
  } finally {
    client.destroy();
  }
  log(`restored ${String(index.length)} objects`);
  return { database: options.intoDatabase, tables, objects: index.length };
}

export { BackupCorrupt, verifyBackup };
