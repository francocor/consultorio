import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { runMigrations } from '../src/db/migrate.js';
import { tenant } from '../src/db/schema/tenant.js';
import {
  operationalRecords,
  operationalReport,
} from '../src/modules/reports/application/operational.js';
import type { ReportScope } from '../src/modules/reports/application/scope.js';
import { availableMinutes, operationalFacts } from '../src/modules/scheduling/index.js';
import type { TenantKeys } from '../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb } from '../src/platform/db/pool.js';
import { createWithTenant } from '../src/platform/db/tenant-context.js';
import { uuidv7 } from '../src/platform/db/uuid.js';

/**
 * Benchmark of the operational reports (task 4.31; design, "Reporting": read models over indexed
 * tables, target p95 under 1 s). It fills a throwaway Postgres 17 with `--appointments` appointments
 * (default 50,000, spread over the year 2025, with a history of moves and confirmations and working
 * hours for twenty professionals) and times, as the application role with the policies on, what the
 * dashboard asks of the database through the same functions the routes call:
 *
 *   1. the report of a month for the whole organization;
 *   2. the report of the whole year for the whole organization;
 *   3. the report of a month for reception of one location;
 *   4. the report of a month for one professional;
 *   5. a page of the drill-down of a month, and of the no-shows of the year.
 *
 *   pnpm --filter @consultorio/api exec tsx scripts/bench-reports.ts                 # 50,000
 *   pnpm --filter @consultorio/api exec tsx scripts/bench-reports.ts --appointments 5000
 *   pnpm --filter @consultorio/api exec tsx scripts/bench-reports.ts --no-indexes    # without 0430
 *
 * Needs Docker and nothing else. Prints a Markdown report (docs/perf/reports.md keeps one). The exit
 * code is 1 when a target is missed, so it can gate a release.
 */
const ROLES_SQL = new URL('../../../infra/postgres/init/01-roles.sql', import.meta.url);
const DATABASE = 'consultorio_bench';
const TARGET_P95_MS = 1000;
const PROFESSIONALS = 20;
const LOCATIONS = 3;
const PATIENTS = 5000;

const { values } = parseArgs({
  options: {
    appointments: { type: 'string', default: '50000' },
    samples: { type: 'string', default: '20' },
    'no-indexes': { type: 'boolean', default: false },
  },
});
const APPOINTMENTS = Number(values.appointments);
const SAMPLES = Number(values.samples);
const WITHOUT_INDEXES = values['no-indexes'];

const YEAR = { from: '2025-01-01', to: '2025-12-31' };
const MONTH = { from: '2025-06-01', to: '2025-06-30' };

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

interface Stats {
  name: string;
  samples: number;
  p50: number;
  p95: number;
  max: number;
}

function stats(name: string, timings: number[]): Stats {
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    name,
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? Number.NaN,
  };
}

const ms = (value: number) => value.toFixed(0);

async function main(): Promise<void> {
  const log = (line: string) => process.stderr.write(`[bench] ${line}\n`);
  log('starting Postgres');
  const container = await new PostgreSqlContainer('postgres:17').withDatabase(DATABASE).start();
  const url = (user: string, password: string) =>
    `postgres://${user}:${password}@${container.getHost()}:${String(container.getPort())}/${DATABASE}`;
  try {
    const admin = new pg.Client({ connectionString: container.getConnectionUri() });
    // The container is stopped in `finally`; a late connection error must not hide the real one.
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query(await readFile(ROLES_SQL, 'utf8'));
    log('migrating');
    await runMigrations(url('app_owner', 'app_owner_dev_only'));

    const runtime = createRuntimeDb(url('app_rw', 'app_rw_dev_only'));
    const withTenant = createWithTenant(runtime.db);
    const tenantId = uuidv7();
    await withTenant({ tenantId, userId: uuidv7() }, (tx) =>
      tx.insert(tenant).values({ id: tenantId, slug: 'bench' }),
    );

    log(`seeding ${String(APPOINTMENTS)} appointments`);
    // Straight into the tables as the superuser with triggers and foreign keys off: the benchmark
    // measures reads, not the guards of the writes (those have their own tests).
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query(
      `CREATE TEMP TABLE bench_locations AS
         SELECT n, app.uuid_v7() AS id FROM generate_series(1, ${String(LOCATIONS)}) n`,
    );
    await admin.query(
      `INSERT INTO location (id, tenant_id, name, time_zone)
         SELECT id, '${tenantId}', 'Sede ' || n, 'America/Argentina/Buenos_Aires' FROM bench_locations`,
    );
    await admin.query(
      `CREATE TEMP TABLE bench_pros AS
         SELECT n, app.uuid_v7() AS id, app.uuid_v7() AS membership_id
           FROM generate_series(1, ${String(PROFESSIONALS)}) n`,
    );
    await admin.query(
      `INSERT INTO membership (id, tenant_id, user_id, roles, display_name)
         SELECT membership_id, '${tenantId}', app.uuid_v7(), ARRAY['professional'], 'Profesional ' || n
           FROM bench_pros`,
    );
    await admin.query(
      `INSERT INTO professional (id, tenant_id, membership_id, specialties)
         SELECT id, '${tenantId}', membership_id,
                CASE WHEN n % 2 = 0 THEN ARRAY['clinica'] ELSE ARRAY['pediatria', 'clinica'] END
           FROM bench_pros`,
    );
    await admin.query(
      `INSERT INTO professional_hours (tenant_id, professional_id, location_id, weekday, start_minute, end_minute)
         SELECT '${tenantId}', p.id, l.id, d, h.start_minute, h.end_minute
           FROM bench_pros p
           JOIN bench_locations l ON l.n = (p.n % ${String(LOCATIONS)}) + 1
           CROSS JOIN generate_series(1, 5) d
           CROSS JOIN (VALUES (540, 780), (840, 1080)) AS h(start_minute, end_minute)`,
    );
    await admin.query(
      `INSERT INTO appointment_type (id, tenant_id, name, duration_minutes)
         VALUES (app.uuid_v7(), '${tenantId}', 'Consulta', 30)`,
    );
    await admin.query(
      `CREATE TEMP TABLE bench_patients AS
         SELECT n, app.uuid_v7() AS id FROM generate_series(1, ${String(PATIENTS)}) n`,
    );
    await admin.query(
      `INSERT INTO patient (id, tenant_id, family_name, given_names, birth_date)
         SELECT id, '${tenantId}', 'Paciente' || n, 'Prueba', DATE '1980-01-01' + (n % 20000)
           FROM bench_patients`,
    );
    // The appointments of 2025: a status mix like a real center (70% attended, 10% no-show, 10%
    // cancelled, the rest still open), 30% booked online, spread over the days, professionals and
    // the quarter hours of the working day.
    await admin.query(
      `CREATE TEMP TABLE bench_appointments AS
         SELECT n, app.uuid_v7() AS id,
                (DATE '2025-01-01' + (n % 365)) + ((9 * 60 + (n / 365) % 36 * 15) || ' minutes')::interval AS local_start
           FROM generate_series(1, ${String(APPOINTMENTS)}) n`,
    );
    await admin.query(
      `INSERT INTO appointment
           (id, tenant_id, patient_id, professional_id, location_id, appointment_type_id,
            starts_at, ends_at, status, source)
         SELECT a.id, '${tenantId}',
                (SELECT id FROM bench_patients WHERE bench_patients.n = (a.n % ${String(PATIENTS)}) + 1),
                p.id, l.id, (SELECT id FROM appointment_type WHERE tenant_id = '${tenantId}' LIMIT 1),
                a.local_start AT TIME ZONE 'America/Argentina/Buenos_Aires',
                (a.local_start + interval '30 minutes') AT TIME ZONE 'America/Argentina/Buenos_Aires',
                CASE WHEN a.n % 100 < 70 THEN 'attended'
                     WHEN a.n % 100 < 80 THEN 'no_show'
                     WHEN a.n % 100 < 90 THEN 'cancelled'
                     WHEN a.n % 100 < 95 THEN 'scheduled' ELSE 'confirmed' END,
                CASE WHEN a.n % 10 < 3 THEN 'online' WHEN a.n % 50 = 7 THEN 'waitlist_offer' ELSE 'staff' END
           FROM bench_appointments a
           JOIN bench_pros p ON p.n = (a.n % ${String(PROFESSIONALS)}) + 1
           JOIN bench_locations l ON l.n = (p.n % ${String(LOCATIONS)}) + 1`,
    );
    await admin.query(
      `INSERT INTO appointment_event (tenant_id, appointment_id, kind, to_status, actor_kind)
         SELECT '${tenantId}'::uuid, id, 'created', 'scheduled', 'staff' FROM bench_appointments
         UNION ALL
         SELECT '${tenantId}'::uuid, id, 'rescheduled', NULL, 'staff' FROM bench_appointments WHERE n % 10 = 0
         UNION ALL
         SELECT '${tenantId}'::uuid, id, 'status_changed', 'confirmed', 'patient' FROM bench_appointments WHERE n % 3 = 0`,
    );
    await admin.query('COMMIT');
    if (WITHOUT_INDEXES) {
      log('dropping the indexes of migration 0430');
      await admin.query(
        'DROP INDEX appointment_report_idx, appointment_event_moved_idx, appointment_event_patient_confirmed_idx',
      );
    }
    for (const table of ['appointment', 'appointment_event', 'professional_hours', 'patient']) {
      await admin.query(`ANALYZE ${table}`);
    }

    const professionalIds = (
      await admin.query<{ id: string }>(
        `SELECT id FROM professional WHERE tenant_id = '${tenantId}' ORDER BY id`,
      )
    ).rows.map((row) => row.id);
    const locationIds = (
      await admin.query<{ id: string }>(
        `SELECT id FROM location WHERE tenant_id = '${tenantId}' ORDER BY id`,
      )
    ).rows.map((row) => row.id);
    const someone = professionalIds[0] ?? '';
    const somewhere = locationIds[0] ?? '';

    const keys = {} as TenantKeys;
    const clock = () => new Date('2026-10-17T12:00:00.000Z');
    const context = { tenantId, userId: uuidv7() };
    const organization: ReportScope = { kind: 'organization' };
    const reception: ReportScope = {
      kind: 'locations',
      locationIds: [somewhere],
      professionalIds: [],
    };
    const professional: ReportScope = { kind: 'professional', professionalId: someone };

    const timeIt = async (name: string, run: () => Promise<unknown>): Promise<Stats> => {
      // Warm-up passes so plans and caches are the steady state of a running application.
      for (let pass = 0; pass < 3; pass += 1) await run();
      const timings: number[] = [];
      for (let pass = 0; pass < SAMPLES; pass += 1) {
        const started = performance.now();
        await run();
        timings.push(performance.now() - started);
      }
      return stats(name, timings);
    };
    const report = (scope: ReportScope, range: { from: string; to: string }) => () =>
      withTenant(context, (tx) =>
        operationalReport(tx, { scope, filters: range }, { keys, clock }),
      );
    const records =
      (scope: ReportScope, range: { from: string; to: string }, group: 'all' | 'no_show') => () =>
        withTenant(context, (tx) =>
          operationalRecords(tx, {
            scope,
            query: { ...range, group, limit: 50, offset: 0 },
          }),
        );

    const cohort = (range: { from: string; to: string }) => ({
      fromDate: range.from,
      toDate: range.to,
      scope: { kind: 'all' as const },
    });
    const results: Stats[] = [];
    results.push(
      await timeIt('Report of a month, whole organization', report(organization, MONTH)),
    );
    results.push(await timeIt('Report of a year, whole organization', report(organization, YEAR)));
    results.push(
      await timeIt('Report of a month, reception of one location', report(reception, MONTH)),
    );
    results.push(await timeIt('Report of a month, one professional', report(professional, MONTH)));
    results.push(
      await timeIt('Drill-down page of 50, a month (all)', records(organization, MONTH, 'all')),
    );
    results.push(
      await timeIt(
        'Drill-down page of 50, no-shows of a year',
        records(organization, YEAR, 'no_show'),
      ),
    );

    // Where the time goes: the counts of the appointments, and the working hours of the period.
    results.push(
      await timeIt('  of which the counts of a year', () =>
        withTenant(context, (tx) =>
          operationalFacts(tx, cohort(YEAR), { now: clock(), recoveredIds: [] }),
        ),
      ),
    );
    results.push(
      await timeIt('  of which the available time of a year', () =>
        withTenant(context, (tx) => availableMinutes(tx, cohort(YEAR), { keys })),
      ),
    );

    const total = (await admin.query<{ n: string }>('SELECT count(*) AS n FROM appointment'))
      .rows[0]?.n;
    const month = (
      await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM appointment WHERE starts_at >= '2025-06-01' AND starts_at < '2025-07-01'`,
      )
    ).rows[0]?.n;
    const version = (
      await admin.query<{ v: string }>("SELECT current_setting('server_version') AS v")
    ).rows[0]?.v;
    const used = (
      await admin.query<{ indexrelname: string; idx_scan: string }>(
        `SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
          WHERE indexrelname IN ('appointment_report_idx', 'appointment_event_moved_idx', 'appointment_event_patient_confirmed_idx')
          ORDER BY indexrelname`,
      )
    ).rows;
    const lines = [
      `Appointments: ${total ?? '?'} in the year 2025 (${month ?? '?'} in the month measured), ${String(PROFESSIONALS)} professionals, ${String(LOCATIONS)} locations. ${WITHOUT_INDEXES ? 'Migration 0430 indexes dropped.' : 'With the indexes of migration 0430.'} Postgres ${version ?? '?'}.`,
      '',
      '| Query | Samples | p50 (ms) | p95 (ms) | max (ms) | Target p95 |',
      '|---|---|---|---|---|---|',
      ...results.map(
        (row) =>
          `| ${row.name} | ${String(row.samples)} | ${ms(row.p50)} | ${ms(row.p95)} | ${ms(row.max)} | < ${String(TARGET_P95_MS)} |`,
      ),
      '',
      `Scans of the new indexes during the run: ${used.length === 0 ? 'none (dropped)' : used.map((row) => `${row.indexrelname} ${row.idx_scan}`).join(', ')}.`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    const missed = results.filter((row) => !row.name.startsWith(' ') && row.p95 >= TARGET_P95_MS);
    if (missed.length > 0) {
      process.stdout.write(`\nTARGET MISSED: ${missed.map((row) => row.name).join('; ')}\n`);
      process.exitCode = 1;
    }
    await runtime.close();
    await admin.end();
  } finally {
    await container.stop();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : 'failed'}\n`);
  process.exit(1);
});
