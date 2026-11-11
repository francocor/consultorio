import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { runRestoreDrill } from './drill/drill.js';
import { drillPassed, formatReport } from './drill/report.js';

/**
 * The restore drill of the LOCAL environment (`pnpm infra:up`), task 6.44: backs up the running
 * database and document bucket, keeps the backup in the object store, restores it from there into a
 * scratch database and bucket, checks that every table came back with its rows and that every chain of
 * audit events verifies from its first event, prints the report and removes the scratch copy.
 *
 *   pnpm drill:restore                    # the defaults are the public values of infra/docker-compose.yml
 *   pnpm drill:restore --keep             # keep the scratch database and bucket to look at them
 *
 * The exit code is 0 only when the drill PASSED. Development only; production uses the managed
 * services of `docs/runbooks/backup-restore.md`, which is also the checklist of the quarterly drill.
 */
const { values } = parseArgs({
  options: {
    container: {
      type: 'string',
      default: process.env['BACKUP_PG_CONTAINER'] ?? 'consultorio-postgres-1',
    },
    database: { type: 'string', default: process.env['POSTGRES_DB'] ?? 'consultorio' },
    user: { type: 'string', default: process.env['POSTGRES_SUPERUSER'] ?? 'postgres' },
    password: {
      type: 'string',
      default: process.env['POSTGRES_SUPERUSER_PASSWORD'] ?? 'postgres_dev_only',
    },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: process.env['POSTGRES_PORT'] ?? '5432' },
    endpoint: { type: 'string', default: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:9000' },
    bucket: { type: 'string', default: process.env['S3_BUCKET'] ?? 'consultorio-files' },
    store: { type: 'string', default: 'consultorio-backups' },
    scratch: { type: 'string' },
    out: { type: 'string', default: process.env['BACKUP_DIR'] ?? 'backups' },
    keep: { type: 'boolean', default: false },
  },
});

// pnpm runs scripts from the package folder; paths are read from where the person typed them.
const base = process.env['INIT_CWD'] ?? process.cwd();

const bucketOf = (bucket: string) => ({
  bucket,
  region: 'us-east-1',
  endpoint: values.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env['MINIO_ROOT_USER'] ?? 'minio_dev',
    secretAccessKey: process.env['MINIO_ROOT_PASSWORD'] ?? 'minio_dev_only_secret',
  },
});

async function main(): Promise<void> {
  const outDir = resolve(base, values.out);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const report = await runRestoreDrill({
    postgres: { container: values.container, database: values.database, user: values.user },
    connectionUrl: (database) =>
      `postgres://${encodeURIComponent(values.user)}:${encodeURIComponent(values.password)}@${values.host}:${values.port}/${database}`,
    bucket: bucketOf(values.bucket),
    store: bucketOf(values.store),
    scratchBucket: values.scratch ?? `consultorio-drill-${stamp}`,
    workDir: outDir,
    keep: values.keep,
    log: (line) => {
      process.stdout.write(`[drill] ${line}\n`);
    },
  });
  const text = formatReport(report);
  process.stdout.write(`\n${text}`);
  // The report holds names of tables, counts and ids: it is the evidence to record, and it is safe to keep.
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, `drill-${stamp}.txt`), text);
  if (!drillPassed(report)) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`[drill] ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exit(1);
});
