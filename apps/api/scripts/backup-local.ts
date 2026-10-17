import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  createBackup,
  restoreBackup,
  verifyBackup,
  type BucketTarget,
  type PostgresTarget,
} from './backup/backup.js';

/**
 * Backup and restore of the LOCAL environment (`pnpm infra:up`): the Postgres database and the
 * document bucket. Development only; production uses the managed services described in
 * `docs/runbooks/backup-restore.md`.
 *
 *   pnpm backup:local                       # writes ./backups/backup-<timestamp>/
 *   pnpm backup:local verify <folder>       # checks the checksums, touches nothing
 *   pnpm backup:local restore <folder> --into consultorio_restore --bucket consultorio-restore
 *
 * The defaults are the public development values of `infra/docker-compose.yml`. A restore always
 * goes into a NEW database and an empty bucket that you name with `--bucket` (there is no default,
 * and it cannot be the live one), so it can never overwrite what is running.
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    container: {
      type: 'string',
      default: process.env['BACKUP_PG_CONTAINER'] ?? 'consultorio-postgres-1',
    },
    database: { type: 'string', default: process.env['POSTGRES_DB'] ?? 'consultorio' },
    user: { type: 'string', default: process.env['POSTGRES_SUPERUSER'] ?? 'postgres' },
    endpoint: { type: 'string', default: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:9000' },
    bucket: { type: 'string' },
    out: { type: 'string', default: process.env['BACKUP_DIR'] ?? 'backups' },
    into: { type: 'string' },
  },
});

// pnpm runs scripts from the package folder; paths are read from where the person typed them.
const base = process.env['INIT_CWD'] ?? process.cwd();
const [command = 'backup', folder] = positionals;

const liveBucket = process.env['S3_BUCKET'] ?? 'consultorio-files';

const postgres: PostgresTarget = {
  container: values.container,
  database: values.database,
  user: values.user,
};
const bucket: BucketTarget = {
  // Backing up reads the live bucket; a restore writes into the one named on the command line.
  bucket: command === 'restore' ? (values.bucket ?? '') : (values.bucket ?? liveBucket),
  region: 'us-east-1',
  endpoint: values.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env['MINIO_ROOT_USER'] ?? 'minio_dev',
    secretAccessKey: process.env['MINIO_ROOT_PASSWORD'] ?? 'minio_dev_only_secret',
  },
};
const log = (line: string): void => {
  process.stdout.write(`[backup] ${line}\n`);
};

async function main(): Promise<void> {
  if (command === 'backup') {
    const { dir, manifest } = await createBackup({
      postgres,
      bucket,
      outDir: resolve(base, values.out),
      log,
    });
    log(
      `database ${String(manifest.database.bytes)} bytes, ${String(manifest.objects.count)} objects (${String(manifest.objects.bytes)} bytes)`,
    );
    log(`folder: ${dir}`);
    return;
  }
  if (!folder) throw new Error(`usage: backup:local ${command} <backup folder>`);
  if (command === 'verify') {
    const manifest = await verifyBackup(resolve(base, folder));
    log(
      `ok: ${String(manifest.objects.count)} objects and the database dump match their checksums`,
    );
    return;
  }
  if (command === 'restore') {
    if (!values.into) throw new Error('restore needs --into <new database name>');
    if (!values.bucket)
      throw new Error('restore needs --bucket <new bucket name>: there is no default');
    if (values.bucket === liveBucket) {
      throw new Error(`--bucket ${values.bucket} is the live bucket: restore into a new one`);
    }
    const report = await restoreBackup({
      dir: resolve(base, folder),
      postgres,
      intoDatabase: values.into,
      bucket,
      log,
    });
    log(
      `restored into database ${report.database} (${String(report.tables)} tables) and bucket ${bucket.bucket} (${String(report.objects)} objects)`,
    );
    return;
  }
  throw new Error('commands: backup | verify <folder> | restore <folder> --into <database>');
}

main().catch((error: unknown) => {
  process.stderr.write(`[backup] ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exit(1);
});
